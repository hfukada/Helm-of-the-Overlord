import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { ClaudeCodeCliAgent } from "./claude-code-cli";
import { OllamaAgent } from "./ollama";
import type { Agent, AgentOptions } from "./types";

export function createAgent(opts: AgentOptions = {}): Agent {
  switch (config.provider) {
    case "claude":
      return new ClaudeCodeCliAgent(opts);
    case "ollama":
      return new OllamaAgent(opts);
    case "cursor":
      logger.error({ provider: config.provider }, 'Cursor provider is not yet implemented');
      throw new Error('Cursor provider is not yet implemented');
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
