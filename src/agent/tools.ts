/**
 * Canonical tool definitions and presets used by agentic nodes.
 *
 * Nodes import these presets rather than maintaining their own string arrays
 * of tool names. Concrete Agent implementations translate `ToolDefinition`
 * objects into their native format.
 */

import type { ToolDefinition } from "./types";

export const READ: ToolDefinition = { name: "Read", description: "Read a file from the working directory." };
export const GLOB: ToolDefinition = { name: "Glob", description: "Match file paths by glob pattern." };
export const GREP: ToolDefinition = { name: "Grep", description: "Search file contents by regex." };
export const WRITE: ToolDefinition = { name: "Write", description: "Write a new file." };
export const EDIT: ToolDefinition = { name: "Edit", description: "Edit an existing file." };
export const BASH: ToolDefinition = { name: "Bash", description: "Execute a shell command." };
export const AGENT: ToolDefinition = { name: "Agent", description: "Spawn a sub-agent for delegated work." };

/** Knowledge-base search via the hoto MCP server. */
export const SEARCH_KNOWLEDGE: ToolDefinition = {
  name: "SearchKnowledge",
  description: "Search the indexed knowledge base for this repo.",
  providerHints: {
    // ClaudeCodeCliAgent wires this to the hoto MCP server.
    mcp: "hoto",
    claudeCliPattern: "mcp__hoto__search_knowledge",
  },
};

/** Read-only file operations. */
export const READ_TOOLS: ToolDefinition[] = [READ, GLOB, GREP];

/** Read + exec (no file mutation). Used by plan-style agents. */
export const READ_EXEC_TOOLS: ToolDefinition[] = [...READ_TOOLS, BASH];

/** Full file modification + exec. Used by implementation agents. */
export const EDIT_TOOLS: ToolDefinition[] = [...READ_TOOLS, WRITE, EDIT, BASH];

/** Edit tools + sub-agent spawning. Used by the implementer. */
export const EDIT_WITH_AGENT_TOOLS: ToolDefinition[] = [...EDIT_TOOLS, AGENT];

/** Add knowledge-base search to any tool list. */
export function withKnowledgeSearch(tools: ToolDefinition[]): ToolDefinition[] {
  if (tools.some((t) => t.name === SEARCH_KNOWLEDGE.name)) return tools;
  return [SEARCH_KNOWLEDGE, ...tools];
}
