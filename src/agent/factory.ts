import { config } from "../shared/config";
import { ClaudeCodeCliAgent } from "./claude-code-cli";
import type { Agent, AgentOptions } from "./types";

export function createAgent(opts: AgentOptions = {}): Agent {
  switch (config.provider) {
    case "claude":
      return new ClaudeCodeCliAgent(opts);
    case "ollama":
      throw new Error("Ollama agent not yet implemented");
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
