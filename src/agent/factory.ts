import { config } from "../shared/config";
import { ClaudeCodeCliAgent } from "./claude-code-cli";
import { OllamaAgent } from "./ollama";
import { CursorAgent } from "./cursor";
import type { Agent, AgentOptions } from "./types";

export function createAgent(opts: AgentOptions = {}): Agent {
  switch (config.provider) {
    case "claude":
      return new ClaudeCodeCliAgent(opts);
    case "ollama":
      return new OllamaAgent(opts);
    case "cursor":
      return new CursorAgent(opts);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
