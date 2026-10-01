import type { ToolDefinition } from "../tools/types.js";
import { WRITE_TOOLS } from "./approval.js";

export const LEAD_TEAM_TOOLS = [
  "team_create",
  "team_disband",
  "team_spawn",
  "team_stop",
  "team_message",
  "team_task_list",
  "team_task_add",
  "team_task_update",
  "team_task_remove",
  "team_merge",
] as const;

export const MEMBER_TEAM_TOOLS = [
  "team_message",
  "team_task_list",
  "team_task_add",
  "team_task_update",
  "team_task_remove",
] as const;

export function isTeamTool(name: string): boolean {
  return name.startsWith("team_");
}

/** 从任意工具列表中去掉全部 team_*（给普通子 Agent）。 */
export function excludeTeamTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((t) => !isTeamTool(t.name));
}

/** Coordinator 生效时从基础工具去掉写文件类。 */
export function filterBaseToolsForLead(
  tools: ToolDefinition[],
  coordinatorActive: boolean,
): ToolDefinition[] {
  if (!coordinatorActive) return tools;
  return tools.filter((t) => !WRITE_TOOLS.has(t.name));
}
