import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import type { AgentCatalog } from "./catalog.js";
import { AgentFatalError, type AgentToolInput } from "./types.js";

export interface AgentToolDeps {
  catalog: AgentCatalog;
  toolNames: () => ReadonlySet<string>;
  start: (input: AgentToolInput, ctx: ToolContext) => Promise<ToolResult>;
}

/** 稳定的委派工具。名单里始终有它，再用 type 区分定义式和分叉。 */
export function createAgentTool(deps: AgentToolDeps): Tool {
  return {
    name: "agent",
    description:
      "把子任务交给独立子助手。type 为 defined 时按角色从空白对话开始；为 fork 时沿用当前对话并转入后台。任务说明放在 task。background 为 true 时定义式也转入后台。",
    sideEffect: true,
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["defined", "fork"],
          description: "defined 使用角色，fork 继承当前对话",
        },
        task: { type: "string", description: "交给子助手的任务说明" },
        name: { type: "string", description: "定义式角色的名字" },
        background: {
          type: "boolean",
          description: "为 true 时转入后台。省略则为前台。fork 始终在后台",
        },
      },
      required: ["type", "task"],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const parsed = readAgentArgs(args);
      if ("error" in parsed) {
        return { ok: false, content: parsed.error, errorCode: "invalid_args" };
      }
      try {
        deps.catalog.refresh(deps.toolNames());
      } catch (err) {
        if (err instanceof AgentFatalError) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      }
      return deps.start(parsed, ctx);
    },
  };
}

function readAgentArgs(
  args: unknown,
): AgentToolInput | { error: string } {
  if (typeof args !== "object" || args === null) {
    return { error: "参数必须是对象" };
  }
  const obj = args as Record<string, unknown>;
  if (obj.type === undefined) {
    return { error: "缺少 type" };
  }
  if (obj.type !== "defined" && obj.type !== "fork") {
    return { error: "type 必须是 defined 或 fork" };
  }
  if (typeof obj.task !== "string" || obj.task.trim() === "") {
    return { error: "任务说明不能为空" };
  }
  if (obj.name !== undefined && typeof obj.name !== "string") {
    return { error: "角色名必须是字符串" };
  }
  if (obj.background !== undefined && typeof obj.background !== "boolean") {
    return { error: "background 必须是布尔值" };
  }
  return {
    type: obj.type,
    task: obj.task.trim(),
    ...(typeof obj.name === "string" ? { name: obj.name } : {}),
    ...(typeof obj.background === "boolean" ? { background: obj.background } : {}),
  };
}
