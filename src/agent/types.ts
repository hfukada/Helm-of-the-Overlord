/**
 * Generic Agent interface. Implementations include ClaudeCodeCliAgent; future
 * implementations might wrap the Anthropic API directly, OpenAI, local models,
 * or entirely different agent architectures.
 *
 * The interface is deliberately minimal. Provider-specific concerns
 * (sandboxing, MCP configs, CLI flags, API keys) stay inside the concrete
 * implementation -- nodes just see `agent.run(opts)`.
 */

import type { TokenUsage } from "../shared/types";

/**
 * Generic tool definition. Concrete agents translate these to their native
 * representation (Claude CLI allowedTools strings, Anthropic tool blocks,
 * OpenAI function schemas, etc.).
 */
export interface ToolDefinition {
  /** Canonical tool name. Convention: PascalCase ("Read", "Edit", "SearchKnowledge"). */
  name: string;
  /** Human-readable description. Some agents inject this into prompts/schemas. */
  description?: string;
  /** JSON schema for arguments. Used by agents that negotiate structured tool schemas. */
  inputSchema?: Record<string, unknown>;
  /**
   * Opaque hints for specific agent implementations.
   * Agents that don't understand a given hint must ignore it.
   *
   * Known hints used by ClaudeCodeCliAgent:
   *   - `mcp: string` -- wire this tool via the named MCP server
   *   - `claudeCliPattern: string` -- use this literal Claude CLI allowedTools pattern
   *                                   (e.g. "Bash(git log:*)")
   */
  providerHints?: Record<string, unknown>;
}

/** An event emitted during an agent run. */
export type AgentEvent =
  | { type: "text"; turnNumber: number; content: string }
  | { type: "thinking"; turnNumber: number; content: string }
  | { type: "tool_call"; turnNumber: number; toolName: string; args: unknown }
  | { type: "tool_result"; turnNumber: number; toolName: string; content: string }
  | { type: "error"; turnNumber: number; content: string };

/** Summary of a single turn (LLM call + tool execution). */
export interface TurnSummary {
  turnNumber: number;
  text: string;
  toolCalls: Array<{ name: string; args: unknown }>;
  hasToolUse: boolean;
  usage: TokenUsage;
}

/** What the agent was told to stop for. */
export type AgentStopReason = "done" | "max_turns" | "budget" | "cancelled" | "error";

export interface AgentRunOptions {
  /** Initial user prompt. */
  prompt: string;
  /** Optional system prompt / role instruction. */
  systemPrompt?: string;
  /** Tools the agent may use. The agent will translate to its native format. */
  tools: ToolDefinition[];
  /** Maximum number of agent turns. Hard cap on work. */
  maxTurns: number;
  /** Working directory hint (filesystem paths or container path). */
  workDir: string;
  /**
   * Extra directories the agent may access, beyond workDir. Some agents
   * (e.g. CLI-based) require an explicit allow-list; API-based agents that
   * execute tools in-process may ignore this.
   */
  addDirs?: string[];

  /** Identifier for persistence and log correlation. */
  agentRunId: string;
  /** Optional task ID for debugging artifacts. */
  taskId?: string;
  /** Repo name for MCP tool calls (used by OllamaAgent). */
  repoName?: string;

  /** Fires for every AgentEvent as it's produced. */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Called after each turn completes. Return a string to inject as the next
   * turn's prompt, or null to send a default "continue"-style prompt.
   */
  onTurnComplete?: (turn: TurnSummary) => Promise<string | null>;
  /** Called after each turn; return true to stop the loop. */
  shouldStop?: (turn: TurnSummary) => boolean;
}

export interface AgentRunResult {
  /** Final user-visible output (typically the text of the last turn). */
  output: string;
  /** Per-turn breakdown. */
  turns: TurnSummary[];
  /** Summed token usage across all turns. */
  totalUsage: TokenUsage;
  /** Error string, or null on success. */
  error: string | null;
  /** Why the agent stopped. */
  stopReason: AgentStopReason;
  /**
   * Agent-specific metadata (session IDs, request IDs, etc.). Opaque to callers.
   * Useful for debugging and future resume/introspection features.
   */
  metadata?: Record<string, unknown>;
}

/**
 * An Agent runs one conversation and returns a result. It owns its own
 * transport, tool execution, and (where applicable) sandboxing.
 *
 * Agents are stateless across `run()` calls by default -- each call starts
 * a fresh conversation. If an implementation supports session resumption,
 * the session ID lives in the result's `metadata`.
 */
export interface Agent {
  run(opts: AgentRunOptions): Promise<AgentRunResult>;
}

/**
 * Provider-agnostic construction options passed to createAgent().
 * Fields map to the intersection of what any provider might need;
 * provider-specific fields are extracted inside the factory.
 */
export interface AgentOptions {
  /** Docker sandbox to run inside. Omit for local execution. */
  sandbox?: { containerName: string; containerWorkDir: string };
  /** Path to an MCP config JSON file. */
  mcpConfigPath?: string;
  /** Model override. */
  model?: string;
  /** Extra directories the agent may access. */
  addDirs?: string[];
  /** Registry key for subprocess tracking. */
  registryKey?: string;
}
