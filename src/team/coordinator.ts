import type { AppConfig } from "../config/types.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Coordinator 双锁：配置能力开关 + 环境变量 MEWCODE_COORDINATOR */
export function isCoordinatorActive(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const available = config.teams?.coordinatorAvailable === true;
  const flag = (env.MEWCODE_COORDINATOR ?? "").trim().toLowerCase();
  return available && TRUTHY.has(flag);
}

export function coordinatorStatusText(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const available = config.teams?.coordinatorAvailable === true;
  const envOn = TRUTHY.has((env.MEWCODE_COORDINATOR ?? "").trim().toLowerCase());
  const active = available && envOn;
  return [
    `Coordinator：${active ? "已启用" : "未启用"}`,
    `- 配置能力开关：${available ? "开" : "关"}`,
    `- 环境变量 MEWCODE_COORDINATOR：${envOn ? "开" : "关"}`,
  ].join("\n");
}
