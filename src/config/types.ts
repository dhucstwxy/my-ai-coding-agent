/** 应用与供应商配置类型 */

export type Protocol = "anthropic" | "openai";

export interface ProviderConfig {
  name: string;
  protocol: Protocol;
  model: string;
  baseUrl: string;
  apiKey: string;
  thinking?: boolean;
}

export interface AppConfig {
  /** 当前启用的供应商标识，对应 ProviderConfig.name */
  activeProvider: string;
  providers: ProviderConfig[];
}

export interface LoadConfigResult {
  config: AppConfig;
  source: "project" | "user";
  warnings: string[];
}
