import type { AppConfig, ProviderConfig, Protocol } from "./types.js";

const PROTOCOLS = new Set<Protocol>(["anthropic", "openai"]);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 将原始 YAML 对象校验并规范化为 AppConfig，同时收集告警 */
export function validateConfig(raw: unknown): {
  config: AppConfig;
  warnings: string[];
} {
  if (!raw || typeof raw !== "object") {
    throw new ConfigError("配置文件格式无效：根节点必须是对象");
  }

  const obj = raw as Record<string, unknown>;
  const active =
    (typeof obj.active === "string" && obj.active) ||
    (typeof obj.activeProvider === "string" && obj.activeProvider) ||
    "";

  if (!active) {
    throw new ConfigError("缺少 active（或 activeProvider）字段，用于指定当前供应商 name");
  }

  if (!Array.isArray(obj.providers) || obj.providers.length === 0) {
    throw new ConfigError("providers 必须是非空数组");
  }

  const warnings: string[] = [];
  const providers: ProviderConfig[] = obj.providers.map((item, index) =>
    validateProvider(item, index),
  );

  const activeProvider = providers.find((p) => p.name === active);
  if (!activeProvider) {
    throw new ConfigError(
      `active「${active}」在 providers 中找不到对应的 name，请检查配置`,
    );
  }

  if (activeProvider.thinking && activeProvider.protocol === "openai") {
    warnings.push(
      "当前协议为 openai（含 DeepSeek 等兼容接口），不支持扩展思考：已忽略 thinking，对话仍可正常进行。",
    );
  }

  return {
    config: { activeProvider: active, providers },
    warnings,
  };
}

function validateProvider(item: unknown, index: number): ProviderConfig {
  if (!item || typeof item !== "object") {
    throw new ConfigError(`providers[${index}] 必须是对象`);
  }
  const p = item as Record<string, unknown>;
  const name = requireString(p.name, `providers[${index}].name`);
  const protocolRaw = requireString(p.protocol, `providers[${index}].protocol`);
  if (!PROTOCOLS.has(protocolRaw as Protocol)) {
    throw new ConfigError(
      `providers[${index}].protocol 仅支持 anthropic 或 openai，收到「${protocolRaw}」`,
    );
  }
  const protocol = protocolRaw as Protocol;
  const model = requireString(p.model, `providers[${index}].model`);
  const baseUrl = requireString(
    p.base_url ?? p.baseUrl,
    `providers[${index}].base_url`,
  );
  const apiKey = requireString(
    p.api_key ?? p.apiKey,
    `providers[${index}].api_key`,
  );

  let thinking: boolean | undefined;
  if (p.thinking !== undefined) {
    if (typeof p.thinking !== "boolean") {
      throw new ConfigError(`providers[${index}].thinking 必须是布尔值`);
    }
    thinking = p.thinking;
  }

  return { name, protocol, model, baseUrl, apiKey, thinking };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`缺少或无效的字段：${field}`);
  }
  return value.trim();
}
