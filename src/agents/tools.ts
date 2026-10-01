import { isTeamTool } from "../team/views.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AgentKind, AgentRecord, RequestSnapshot } from "./types.js";

const AGENT_TOOL = "agent";

/**
 * 子循环启动时固定的工具列表。转入后台不再重新计算。
 * 定义式去掉委派工具与团队工具，再按白名单和黑名单收窄。
 * Fork 使用快照副本后再去掉团队工具。
 */
export function visibleTools(input: {
  kind: AgentKind;
  all: ToolDefinition[];
  role?: AgentRecord;
  snapshot?: RequestSnapshot;
}): ToolDefinition[] {
  if (input.kind === "fork") {
    return (input.snapshot?.tools ?? []).filter((tool) => !isTeamTool(tool.name));
  }
  let list = input.all.filter(
    (tool) => tool.name !== AGENT_TOOL && !isTeamTool(tool.name),
  );
  const role = input.role;
  if (role?.tools !== undefined) {
    const allow = new Set(role.tools);
    list = list.filter((tool) => allow.has(tool.name));
  }
  if (role?.disallowedTools !== undefined && role.disallowedTools.length > 0) {
    const deny = new Set(role.disallowedTools);
    list = list.filter((tool) => !deny.has(tool.name));
  }
  return list;
}

export { AGENT_TOOL };
