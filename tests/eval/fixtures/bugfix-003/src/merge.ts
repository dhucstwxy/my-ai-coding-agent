export type Config = Record<string, unknown>;

export function mergeConfigs(a: Config, b: Config): Config {
  return { ...a, ...b };
}
