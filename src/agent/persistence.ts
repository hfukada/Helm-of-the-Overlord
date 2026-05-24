/**
 * Persistence wrapper for agent runs.
 *
 * Each agentic node historically did:
 *   1. INSERT INTO agent_runs at start
 *   2. call the agent
 *   3. UPDATE agent_runs with status, tokens, error on finish
 *   4. INSERT INTO token_usage_daily
 *
 * This module centralizes that pattern and the agent_stream event storage.
 * Nodes call `runAgent(agent, spec)` and get a result back.
 */

import { getDb } from "../knowledge/db";
import { logger } from "../shared/logger";
import { incrementTokenCounters } from "../shared/token-counters";
import { config } from "../shared/config";
import type {
  Agent,
  AgentEvent,
  AgentRunOptions,
  AgentRunResult,
  ToolDefinition,
  TurnSummary,
} from "./types";
import type { StreamEventType } from "../shared/types";

export interface AgentRunSpec {
  nodeName: string;
  taskId: string;
  childTaskId?: string;
  prompt: string;
  systemPrompt?: string;
  tools: ToolDefinition[];
  maxTurns: number;
  workDir: string;
  addDirs?: string[];
  model?: string;
  /** Repo name forwarded to AgentRunOptions for MCP tool dispatch. */
  repoName?: string;

  /** Forwarded to the agent (in addition to DB event storage). */
  onEvent?: (event: AgentEvent) => void;
  onTurnComplete?: (turn: TurnSummary) => Promise<string | null>;
  shouldStop?: (turn: TurnSummary) => boolean;
}

/**
 * Run an agent while recording persistence (agent_runs, agent_stream,
 * token_usage_daily). Returns the same AgentRunResult the agent produced,
 * and the newly-assigned agentRunId for callers that need it.
 */
export async function runAgent(
  agent: Agent,
  agentRunId: string,
  spec: AgentRunSpec,
): Promise<AgentRunResult> {
  const db = getDb();
  const model = spec.model ?? config.defaultModel;

  db.run(
    `INSERT INTO agent_runs (id, task_id, node_name, agent_type, status, prompt, model, child_task_id)
     VALUES (?, ?, ?, 'agentic', 'running', ?, ?, ?)`,
    [agentRunId, spec.taskId, spec.nodeName, spec.prompt, model, spec.childTaskId ?? null],
  );

  // Wrap onEvent to also persist to agent_stream.
  const wrappedOnEvent = (event: AgentEvent) => {
    try {
      const streamType = mapEventType(event.type);
      const content = stringifyEventContent(event);
      db.run(
        "INSERT INTO agent_stream (agent_run_id, event_type, content) VALUES (?, ?, ?)",
        [agentRunId, streamType, content],
      );
    } catch (err) {
      logger.warn("Failed to persist agent event", { error: String(err) });
    }
    spec.onEvent?.(event);
  };

  const opts: AgentRunOptions = {
    prompt: spec.prompt,
    systemPrompt: spec.systemPrompt,
    tools: spec.tools,
    maxTurns: spec.maxTurns,
    workDir: spec.workDir,
    addDirs: spec.addDirs,
    agentRunId,
    taskId: spec.taskId,
    repoName: spec.repoName,
    onEvent: wrappedOnEvent,
    onTurnComplete: spec.onTurnComplete,
    shouldStop: spec.shouldStop,
  };

  let result: AgentRunResult;
  try {
    result = await agent.run(opts);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const now = new Date().toISOString();
    db.run(
      `UPDATE agent_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
      [errMsg, now, agentRunId],
    );
    throw err;
  }

  const now = new Date().toISOString();
  db.run(
    `UPDATE agent_runs SET
       status = ?, output = ?, token_input = ?, token_output = ?,
       cost_usd = ?, finished_at = ?, error = ?
     WHERE id = ?`,
    [
      result.error ? "failed" : "completed",
      result.output,
      result.totalUsage.input_tokens,
      result.totalUsage.output_tokens,
      result.totalUsage.cost_usd,
      now,
      result.error,
      agentRunId,
    ],
  );

  const today = new Date().toISOString().slice(0, 10);
  db.run(
    `INSERT INTO token_usage_daily (date, model, input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date, model) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cost_usd = cost_usd + excluded.cost_usd`,
    [today, model, result.totalUsage.input_tokens, result.totalUsage.output_tokens, result.totalUsage.cost_usd],
  );

  try {
    incrementTokenCounters(
      model,
      result.totalUsage.input_tokens,
      result.totalUsage.output_tokens,
      result.totalUsage.cost_usd ?? 0
    );
  } catch (err) {
    logger.warn("incrementTokenCounters failed", { err });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

function mapEventType(type: AgentEvent["type"]): StreamEventType {
  // agent_stream.event_type is a legacy enum (text/thinking/tool_use/tool_result/error).
  // "tool_call" in the generic AgentEvent maps to the legacy "tool_use" value so
  // existing hoto-ui readers keep working.
  if (type === "tool_call") return "tool_use";
  return type;
}

function stringifyEventContent(event: AgentEvent): string {
  switch (event.type) {
    case "text":
    case "thinking":
    case "error":
      return event.content;
    case "tool_call": {
      const argsStr = typeof event.args === "string" ? event.args : JSON.stringify(event.args);
      return `${event.toolName}: ${argsStr}`;
    }
    case "tool_result":
      return event.content;
  }
}
