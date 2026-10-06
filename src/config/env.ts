/** 配置中的环境变量展开与 API Key 覆盖 */

const ENV_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * 展开字符串中的 ${VAR}。
 * 任一变量缺失时抛出，避免把字面量 `${FOO}` 当成密钥发出去。
 */
export function expandEnvRefs(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const missing: string[] = [];
  const expanded = value.replace(ENV_VAR_RE, (_match, name: string) => {
    const v = env[name];
    if (v === undefined || v === "") {
      missing.push(name);
      return "";
    }
    return v;
  });
  if (missing.length > 0) {
    const uniq = [...new Set(missing)];
    throw new Error(
      `环境变量未设置或为空：${uniq.join(", ")}。请 export / docker -e 注入后再启动。`,
    );
  }
  return expanded;
}

/** 供应商标识 → 环境变量后缀，如 deepseek → DEEPSEEK */
export function providerEnvSuffix(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * 解析单个 provider 的最终 apiKey。
 * 优先级：MEWCODE_<NAME>_API_KEY > MEWCODE_API_KEY（仅当前 active）> yaml（含 ${VAR} 展开）
 */
export function resolveProviderApiKey(options: {
  providerName: string;
  apiKeyFromConfig: string;
  activeProvider: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = options.env ?? process.env;

  const suffix = providerEnvSuffix(options.providerName);
  const specific = env[`MEWCODE_${suffix}_API_KEY`]?.trim();
  if (specific) {
    return specific;
  }

  if (options.providerName === options.activeProvider) {
    const global = env.MEWCODE_API_KEY?.trim();
    if (global) {
      return global;
    }
  }

  const apiKey = expandEnvRefs(options.apiKeyFromConfig, env);
  if (!apiKey.trim()) {
    throw new Error(
      `providers「${options.providerName}」的 api_key 为空。可在 yaml 填写，或设置 MEWCODE_API_KEY / MEWCODE_${suffix}_API_KEY。`,
    );
  }
  return apiKey;
}
