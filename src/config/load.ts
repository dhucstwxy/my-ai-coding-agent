import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { resolveProviderApiKey } from "./env.js";
import { projectConfigPath, userConfigPath } from "./paths.js";
import type { AppConfig, LoadConfigResult } from "./types.js";
import { ConfigError, validateConfig } from "./validate.js";

/** 项目配置优先，否则用户目录配置 */
export function loadConfig(cwd = process.cwd()): LoadConfigResult {
  const projectPath = projectConfigPath(cwd);
  const userPath = userConfigPath();

  if (fs.existsSync(projectPath)) {
    return loadFromFile(projectPath, "project");
  }
  if (fs.existsSync(userPath)) {
    return loadFromFile(userPath, "user");
  }

  throw new ConfigError(
    `未找到配置文件。请复制 .mewcode/config.example.yaml 为 .mewcode/config.yaml（项目内）或 ~/.mewcode/config.yaml（用户目录），并填写 api_key（或用环境变量 MEWCODE_API_KEY 注入）。\n已尝试：\n- ${projectPath}\n- ${userPath}`,
  );
}

function loadFromFile(
  filePath: string,
  source: "project" | "user",
): LoadConfigResult {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new ConfigError(
      `无法读取配置文件 ${filePath}：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(
      `YAML 解析失败（${filePath}）：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { config, warnings } = validateConfig(raw);
  return {
    config: applyApiKeyEnv(config),
    source,
    warnings,
  };
}

/** 展开 ${VAR}，并应用 MEWCODE_*_API_KEY 覆盖 */
function applyApiKeyEnv(config: AppConfig): AppConfig {
  try {
    const providers = config.providers.map((p) => ({
      ...p,
      apiKey: resolveProviderApiKey({
        providerName: p.name,
        apiKeyFromConfig: p.apiKey,
        activeProvider: config.activeProvider,
      }),
    }));
    return { ...config, providers };
  } catch (err) {
    throw new ConfigError(
      err instanceof Error ? err.message : String(err),
    );
  }
}
