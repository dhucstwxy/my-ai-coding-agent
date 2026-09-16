import type { BuildPromptInput, EnvironmentInfo } from "./types.js";

/** 生成环境信息段落（变化内容，不进稳定前缀） */
export function formatEnvironment(input: {
  workspaceRoot: string;
  now: Date;
  platform: string;
}): string {
  const timeLabel = formatTimeLabel(input.now);
  return [
    "## 环境信息",
    `- 工作区根路径：${input.workspaceRoot}`,
    `- 当前时间：${timeLabel}`,
    `- 操作系统：${input.platform}`,
  ].join("\n");
}

export function toEnvironmentInfo(input: BuildPromptInput): EnvironmentInfo {
  return {
    workspaceRoot: input.workspaceRoot,
    timeLabel: formatTimeLabel(input.now),
    platform: input.platform,
  };
}

export function formatTimeLabel(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}
