import type { ProviderConfig } from "../config/types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";
import type { ChatProvider } from "./types.js";

export function createProvider(config: ProviderConfig): ChatProvider {
  switch (config.protocol) {
    case "openai":
      return createOpenAIProvider(config);
    case "anthropic":
      return createAnthropicProvider(config);
    default: {
      const exhaustive: never = config.protocol;
      throw new Error(`未知协议：${String(exhaustive)}`);
    }
  }
}
