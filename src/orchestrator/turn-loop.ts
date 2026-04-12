/**
 * Resume-based turn loop for Claude CLI.
 *
 * Runs `claude --print --max-turns 1` per turn, inspects output between turns,
 * and uses `--resume <session-id>` to continue the conversation. This gives
 * hoto control over the agent loop: we can inject context, detect loops,
 * enforce budgets, and nudge the agent between turns.
 */

import { randomUUID } from "node:crypto";
import { claudeStream, type ClaudeOptions, type ClaudeEvent } from "../shared/claude-cli";
import { logger } from "../shared/logger";
import type { TokenUsage, StreamEventType } from "../shared/types";
import { getDb } from "../knowledge/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TurnLoopOptions {
  prompt: string;
  systemPrompt?: string;
  workDir: string;
  model?: string;
  maxTurns: number;
  allowedTools?: string[];
  mcpConfigPath?: string;
  addDirs?: string[];
  agentRunId: string;
  taskId?: string;
  onEvent?: (eventType: StreamEventType, content: string) => void;
  containerName?: string;
  containerWorkDir?: string;

  /** Called between turns. Return a message to inject, or null to send "continue". */
  onTurnComplete?: (turn: TurnResult) => Promise<string | null>;
  /** Called to check if we should stop early. */
  shouldStop?: (turn: TurnResult) => boolean;
}

export interface TurnResult {
  turnNumber: number;
  text: string;
  toolCalls: string[];
  hasToolUse: boolean;
  usage: TokenUsage;
}

export interface TurnLoopResult {
  output: string;
  turns: TurnResult[];
  totalUsage: TokenUsage;
  sessionId: string;
  error: string | null;
  stopReason: "done" | "max_turns" | "budget" | "cancelled" | "error";
}

// ---------------------------------------------------------------------------
// Nudge helpers
// ---------------------------------------------------------------------------

const UNEXECUTED_INTENT_PATTERNS = [
  /\bi (?:will|would|can|shall|'ll)\b/i,
  /\blet me\b/i,
  /\bhere(?:'s| is) (?:what|how)\b/i,
  /\bfirst,? i(?:'ll| will)\b/i,
  /\bthe (?:steps|approach|plan) (?:would|will) be\b/i,
];

function looksLikeUnexecutedIntent(text: string): boolean {
  if (!text || text.length < 20) return false;
  return UNEXECUTED_INTENT_PATTERNS.some((p) => p.test(text));
}

function detectLoop(recentToolCalls: string[][]): boolean {
  if (recentToolCalls.length < 3) return false;
  const last3 = recentToolCalls.slice(-3);
  const sig = (calls: string[]) => JSON.stringify(calls.sort());
  return sig(last3[0]) === sig(last3[1]) && sig(last3[1]) === sig(last3[2]);
}

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------

export async function runTurnLoop(opts: TurnLoopOptions): Promise<TurnLoopResult> {
  const sessionId = randomUUID();
  const turns: TurnResult[] = [];
  const recentToolCalls: string[][] = [];
  let allText = "";
  const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  let error: string | null = null;
  let stopReason: TurnLoopResult["stopReason"] = "done";

  const db = getDb();

  for (let turnNum = 1; turnNum <= opts.maxTurns; turnNum++) {
    const isFirstTurn = turnNum === 1;

    // Build per-turn prompt
    let turnPrompt: string;
    if (isFirstTurn) {
      turnPrompt = opts.prompt;
    } else {
      // Check if onTurnComplete provided a nudge/injection
      const lastTurn = turns[turns.length - 1];
      const injected = opts.onTurnComplete
        ? await opts.onTurnComplete(lastTurn)
        : null;
      turnPrompt = injected ?? "continue";
    }

    // Track tool calls for this turn
    const turnToolCalls: string[] = [];
    let turnText = "";

    const cliOpts: ClaudeOptions = {
      prompt: turnPrompt,
      systemPrompt: isFirstTurn ? opts.systemPrompt : undefined,
      cwd: opts.containerName ? undefined : opts.workDir,
      model: opts.model,
      maxTurns: 1,
      allowedTools: opts.allowedTools,
      mcpConfigPath: opts.mcpConfigPath,
      addDirs: opts.addDirs,
      containerName: opts.containerName,
      containerWorkDir: opts.containerWorkDir,
      sessionId: isFirstTurn ? sessionId : undefined,
      resumeId: isFirstTurn ? undefined : sessionId,
    };

    logger.info("Turn loop: starting turn", {
      agentRunId: opts.agentRunId,
      turn: turnNum,
      maxTurns: opts.maxTurns,
      isResume: !isFirstTurn,
      sessionId,
    });

    const result = await claudeStream(cliOpts, (evt: ClaudeEvent) => {
      // Track tool use
      if (evt.type === "tool_use") {
        // Tool use events look like "Tool: ToolName" or "ToolName: {args}"
        const toolName = evt.content.startsWith("Tool: ")
          ? evt.content.slice(6)
          : evt.content.split(":")[0].trim();
        if (toolName && !turnToolCalls.includes(toolName)) {
          turnToolCalls.push(toolName);
        }
      }

      if (evt.type === "text") {
        turnText += evt.content;
      }

      // Forward events
      opts.onEvent?.(evt.type, evt.content);
    });

    // Build turn result
    const turnUsage: TokenUsage = {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cost_usd: result.usage.costUsd,
    };

    const turn: TurnResult = {
      turnNumber: turnNum,
      text: turnText || result.text,
      toolCalls: turnToolCalls,
      hasToolUse: turnToolCalls.length > 0,
      usage: turnUsage,
    };

    turns.push(turn);
    recentToolCalls.push(turnToolCalls);
    if (recentToolCalls.length > 5) recentToolCalls.shift();

    // Accumulate
    totalUsage.input_tokens += turnUsage.input_tokens;
    totalUsage.output_tokens += turnUsage.output_tokens;
    totalUsage.cost_usd += turnUsage.cost_usd;
    if (turn.text) allText = turn.text; // Use latest text (not concatenate -- each turn's text is the cumulative response)

    // Log turn to agent_turns table
    try {
      db.run(
        `INSERT INTO agent_turns (agent_run_id, turn_number, has_tool_use, tool_names, text_output, input_tokens, output_tokens, cost_usd, stop_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          opts.agentRunId,
          turnNum,
          turn.hasToolUse ? 1 : 0,
          turnToolCalls.length > 0 ? JSON.stringify(turnToolCalls) : null,
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

    logger.info("Turn loop: turn complete", {
      agentRunId: opts.agentRunId,
      turn: turnNum,
      hasToolUse: turn.hasToolUse,
      toolCalls: turnToolCalls,
      textLen: turn.text.length,
      tokens: turnUsage.input_tokens + turnUsage.output_tokens,
    });

    // Check for errors
    if (result.error) {
      // max-turns-reached from --max-turns 1 is expected when tools are used
      if (!result.error.includes("max turns limit")) {
        error = result.error;
        stopReason = "error";
        break;
      }
    }

    // Check shouldStop hook
    if (opts.shouldStop?.(turn)) {
      stopReason = "cancelled";
      break;
    }

    // Done detection: no tool use means Claude is finished
    if (!turn.hasToolUse) {
      stopReason = "done";
      break;
    }

    // Max turns check
    if (turnNum >= opts.maxTurns) {
      stopReason = "max_turns";
      break;
    }

    // Between-turn nudges
    // 1. Unexecuted intent (early turns only)
    if (turnNum <= 2 && !turn.hasToolUse && looksLikeUnexecutedIntent(turn.text)) {
      // This shouldn't normally trigger since no tool use -> done above,
      // but handle the edge case where tools were used AND text looks like intent
    }

    // 2. Loop detection
    if (detectLoop(recentToolCalls)) {
      logger.warn("Turn loop: detected repetitive tool calls", {
        agentRunId: opts.agentRunId,
        turn: turnNum,
        pattern: recentToolCalls.slice(-3),
      });
      // The nudge will be injected via onTurnComplete on the next iteration
      // If no onTurnComplete is provided, we inject a default nudge
      if (!opts.onTurnComplete) {
        // Override the next turn's prompt by pushing a synthetic "last turn"
        // that the default "continue" path will pick up
        turns[turns.length - 1] = {
          ...turn,
          text: "LOOP_DETECTED",
        };
      }
    }
  }

  // Use the final turn's text as output, or the accumulated text
  const output = allText || (turns.length > 0 ? turns[turns.length - 1].text : "");

  // Store session_id on the agent_run
  try {
    db.run("UPDATE agent_runs SET session_id = ? WHERE id = ?", [sessionId, opts.agentRunId]);
  } catch {}

  logger.info("Turn loop: completed", {
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
    sessionId,
    error,
    stopReason,
  };
}
