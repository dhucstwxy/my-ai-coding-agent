import type { ToolDefinition } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AgentMode } from "./types.js";
import { PLAN_READONLY_TOOLS } from "./types.js";

/** 会话级 Plan/Execute 模式（进程内） */
export class PlanModeStore {
  private readonly modes = new Map<string, AgentMode>();

  getMode(sessionId: string): AgentMode {
    return this.modes.get(sessionId) ?? "execute";
  }

  setMode(sessionId: string, mode: AgentMode): void {
    this.modes.set(sessionId, mode);
  }
}

export function filterToolsForMode(
  registry: ToolRegistry,
  mode: AgentMode,
): ToolDefinition[] {
  const all = registry.toDefinitions();
  if (mode === "execute") return all;
  const allow = new Set<string>(PLAN_READONLY_TOOLS);
  return all.filter((t) => allow.has(t.name));
}
