/**
 * ClaudeCodeCliAgent -- implements the generic Agent interface by driving
 * the Claude Code CLI via `claude --print` with a resume-based turn loop.
 *
 * Owns:
 *   - Per-turn invocation (max-turns=1) + resume sessions for multi-turn work
 *   - Translation of generic ToolDefinition[] to Claude CLI --allowedTools flags
 *   - Destructive git command denylist
 *   - Optional sandbox (docker exec) execution
 *   - Optional MCP wiring for SearchKnowledge tool
 *   - agent_turns table per-turn logging, session_id storage on agent_runs
 */

import { randomUUID } from "node:crypto";
import { claudeStream, type ClaudeOptions, type ClaudeEvent } from "../shared/claude-cli";
import { logger } from "../shared/logger";
import { getDb } from "../knowledge/db";
import type { TokenUsage } from "../shared/types";
import type {
  Agent,
  AgentEvent,
  AgentRunOptions,
  AgentRunResult,
  ToolDefinition,
  TurnSummary,
  AgentStopReason,
} from "./types";

export interface ClaudeCodeCliAgentOptions {
  /** Docker sandbox to execute the CLI inside of. Omit for local execution. */
  sandbox?: { containerName: string; containerWorkDir: string };
  /** Path to an MCP config JSON file. Only used if tools include MCP hints. */
  mcpConfigPath?: string;
  /** Model override. Otherwise uses config.defaultModel. */
  model?: string;
  /** Extra directories the CLI may access (--add-dir). */
  addDirs?: string[];
}

export class ClaudeCodeCliAgent implements Agent {
  private readonly sandbox?: { containerName: string; containerWorkDir: string };
  private readonly mcpConfigPath?: string;
  private readonly model?: string;
  private readonly addDirs?: string[];

  constructor(opts: ClaudeCodeCliAgentOptions = {}) {
    this.sandbox = opts.sandbox;
    this.mcpConfigPath = opts.mcpConfigPath;
    this.model = opts.model;
    this.addDirs = opts.addDirs;
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const sessionId = randomUUID();
    const turns: TurnSummary[] = [];
    const recentToolNames: string[][] = [];
    let lastText = "";
    const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
    let error: string | null = null;
    let stopReason: AgentStopReason = "done";

    let db: ReturnType<typeof getDb> | null = null;
    try { db = getDb(); } catch {}

    const allowedTools = this.toAllowedTools(opts.tools);

    for (let turnNum = 1; turnNum <= opts.maxTurns; turnNum++) {
      const isFirstTurn = turnNum === 1;

      // Decide what to send this turn.
      let turnPrompt: string;
      if (isFirstTurn) {
        turnPrompt = opts.prompt;
      } else {
        const lastTurn = turns[turns.length - 1];
        const injected = opts.onTurnComplete ? await opts.onTurnComplete(lastTurn) : null;
        turnPrompt = injected ?? "continue";
      }

      const turnToolCalls: Array<{ name: string; args: unknown }> = [];
      let turnText = "";

      const cliOpts: ClaudeOptions = {
        prompt: turnPrompt,
        systemPrompt: isFirstTurn ? opts.systemPrompt : undefined,
        cwd: this.sandbox ? undefined : opts.workDir,
        model: this.model,
        maxTurns: 1,
        allowedTools,
        mcpConfigPath: this.mcpConfigPath,
        addDirs: opts.addDirs ?? this.addDirs,
        containerName: this.sandbox?.containerName,
        containerWorkDir: this.sandbox?.containerWorkDir,
        sessionId: isFirstTurn ? sessionId : undefined,
        resumeId: isFirstTurn ? undefined : sessionId,
      };

      logger.info("Agent turn starting", {
        agentRunId: opts.agentRunId,
        turn: turnNum,
        maxTurns: opts.maxTurns,
        isResume: !isFirstTurn,
        sessionId,
      });

      const cliResult = await claudeStream(cliOpts, (evt: ClaudeEvent) => {
        // Translate Claude CLI events to generic AgentEvents.
        const generic = translateEvent(evt, turnNum);
        if (!generic) return;

        if (generic.type === "text") {
          turnText += generic.content;
        } else if (generic.type === "tool_call") {
          // Dedup by tool name within a turn (args often arrive fragmented).
          if (!turnToolCalls.some((tc) => tc.name === generic.toolName)) {
            turnToolCalls.push({ name: generic.toolName, args: generic.args });
          }
        }

        opts.onEvent?.(generic);
      });

      const turnUsage: TokenUsage = {
        input_tokens: cliResult.usage.inputTokens,
        output_tokens: cliResult.usage.outputTokens,
        cost_usd: cliResult.usage.costUsd,
      };

      const turn: TurnSummary = {
        turnNumber: turnNum,
        text: turnText || cliResult.text,
        toolCalls: turnToolCalls,
        hasToolUse: turnToolCalls.length > 0,
        usage: turnUsage,
      };

      turns.push(turn);
      recentToolNames.push(turnToolCalls.map((tc) => tc.name));
      if (recentToolNames.length > 5) recentToolNames.shift();

      totalUsage.input_tokens += turnUsage.input_tokens;
      totalUsage.output_tokens += turnUsage.output_tokens;
      totalUsage.cost_usd += turnUsage.cost_usd;
      if (turn.text) lastText = turn.text;

      // Per-turn log
      try {
        db?.run(
          `INSERT INTO agent_turns (agent_run_id, turn_number, has_tool_use, tool_names, text_output, input_tokens, output_tokens, cost_usd, stop_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            opts.agentRunId,
            turnNum,
            turn.hasToolUse ? 1 : 0,
            turnToolCalls.length > 0 ? JSON.stringify(turnToolCalls.map((tc) => tc.name)) : null,
            turn.text ? turn.text.slice(0, 5000) : null,
            turnUsage.input_tokens,
            turnUsage.output_tokens,
            turnUsage.cost_usd,
            turn.hasToolUse ? "tool_use" : "end_turn",
          ],
        );
      } catch (err) {
        logger.warn("Failed to log agent turn", { error: String(err) });
      }

      logger.info("Agent turn complete", {
        agentRunId: opts.agentRunId,
        turn: turnNum,
        hasToolUse: turn.hasToolUse,
        toolCalls: turnToolCalls.map((tc) => tc.name),
        textLen: turn.text.length,
        tokens: turnUsage.input_tokens + turnUsage.output_tokens,
      });

      // Errors (ignore the expected max-turns=1 "limit" message when tools were used).
      if (cliResult.error) {
        if (!cliResult.error.includes("max turns limit")) {
          error = cliResult.error;
          stopReason = "error";
          opts.onEvent?.({ type: "error", turnNumber: turnNum, content: cliResult.error });
          break;
        }
      }

      if (opts.shouldStop?.(turn)) {
        stopReason = "cancelled";
        break;
      }

      if (!turn.hasToolUse) {
        stopReason = "done";
        break;
      }

      if (turnNum >= opts.maxTurns) {
        stopReason = "max_turns";
        break;
      }

      if (detectLoop(recentToolNames)) {
        logger.warn("Agent loop detected -- repeating tool pattern", {
          agentRunId: opts.agentRunId,
          turn: turnNum,
          pattern: recentToolNames.slice(-3),
        });
      }
    }

    const output = lastText || (turns.length > 0 ? turns[turns.length - 1].text : "");

    try {
      db?.run("UPDATE agent_runs SET session_id = ? WHERE id = ?", [sessionId, opts.agentRunId]);
    } catch {}

    logger.info("Agent run complete", {
      agentRunId: opts.agentRunId,
      totalTurns: turns.length,
      stopReason,
      totalTokens: totalUsage.input_tokens + totalUsage.output_tokens,
      totalCost: totalUsage.cost_usd.toFixed(4),
      sessionId,
    });

    return {
      output,
      turns,
      totalUsage,
      error,
      stopReason,
      metadata: { sessionId },
    };
  }

  /**
   * Translate generic ToolDefinitions to Claude CLI --allowedTools arguments.
   *
   * Recognised providerHints:
   *   - `claudeCliPattern` -- use this literal pattern (e.g. "Bash(git log:*)")
   *   - `mcp: "hoto"` with `claudeCliPattern: "mcp__hoto__search_knowledge"` --
   *     the pattern is also an allowedTool.
   *
   * Without hints, the tool name is used verbatim (matches built-in Claude tools
   * like "Read", "Edit", "Bash", "Glob", "Grep", "Agent").
   */
  private toAllowedTools(tools: ToolDefinition[]): string[] {
    const result: string[] = [];
    for (const tool of tools) {
      const hints = tool.providerHints ?? {};
      if (typeof hints.claudeCliPattern === "string") {
        result.push(hints.claudeCliPattern);
      } else {
        result.push(tool.name);
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Event translation
// ---------------------------------------------------------------------------

/**
 * Parse Claude CLI stream events into generic AgentEvents.
 * Returns null for events we don't emit (internal CLI chatter).
 */
function translateEvent(evt: ClaudeEvent, turnNumber: number): AgentEvent | null {
  switch (evt.type) {
    case "text":
      return { type: "text", turnNumber, content: evt.content };
    case "thinking":
      return { type: "thinking", turnNumber, content: evt.content };
    case "tool_use": {
      // content is "Tool: ToolName" on content_block_start,
      // or "ToolName: <partial_json>" / partial JSON on deltas.
      const content = evt.content;
      let toolName: string;
      let args: unknown;
      if (content.startsWith("Tool: ")) {
        toolName = content.slice(6).trim();
        args = undefined;
      } else if (content.includes(":")) {
        const colonIdx = content.indexOf(":");
        toolName = content.slice(0, colonIdx).trim();
        args = content.slice(colonIdx + 1).trim();
      } else {
        toolName = content.trim();
        args = undefined;
      }
      if (!toolName) return null;
      return { type: "tool_call", turnNumber, toolName, args };
    }
    case "tool_result":
      return { type: "tool_result", turnNumber, toolName: "", content: evt.content };
    case "error":
      return { type: "error", turnNumber, content: evt.content };
  }
}

// ---------------------------------------------------------------------------
// Loop detection
// ---------------------------------------------------------------------------

function detectLoop(recentToolNames: string[][]): boolean {
  if (recentToolNames.length < 3) return false;
  const last3 = recentToolNames.slice(-3);
  const sig = (names: string[]) => JSON.stringify([...names].sort());
  return sig(last3[0]) === sig(last3[1]) && sig(last3[1]) === sig(last3[2]);
}
