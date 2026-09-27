import type { Tool, ToolResult } from "../tools/types.js";
import type { SkillCatalog } from "./catalog.js";
import { runSkill, type SkillRunDeps } from "./run.js";
import type { SkillSession } from "./session.js";

export interface LoadSkillDeps {
  catalog: SkillCatalog;
  session: SkillSession;
  run: SkillRunDeps;
}

/** 系统级工具：激活 Skill。任何白名单都不能把它拿掉。 */
export function createLoadSkillTool(deps: LoadSkillDeps): Tool {
  return {
    name: "load_skill",
    description:
      "按名字加载并激活一个 Skill，将其操作说明钉在后续回合。参数 name 必填，args 可选。",
    sideEffect: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill 名字" },
        args: { type: "string", description: "传给操作说明的参数" },
      },
      required: ["name"],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const parsed = readLoadArgs(args);
      if (parsed.error) {
        return { ok: false, content: parsed.error, errorCode: "invalid_args" };
      }
      const sessionId = ctx.sessionId;
      if (!sessionId) {
        return {
          ok: false,
          content: "当前没有会话，无法激活 Skill",
          errorCode: "invalid_args",
        };
      }
      const skill = deps.catalog.get(parsed.name);
      if (!skill) {
        return {
          ok: false,
          content: `找不到 Skill：${parsed.name}`,
          errorCode: "invalid_args",
        };
      }

      if (skill.mode === "isolated") {
        const summary = await runSkill(
          { sessionId, skill, args: parsed.args },
          deps.run,
        );
        return { ok: true, content: summary };
      }

      deps.session.activate(sessionId, skill.name, parsed.args);
      return { ok: true, content: renderShared(skill, parsed.args) };
    },
  };
}

function renderShared(
  skill: { name: string; body: string; companions: string[] },
  args: string,
): string {
  const body = skill.body.split("$ARGUMENTS").join(args);
  const lines = [`已激活 Skill：${skill.name}`, "", body.trim()];
  if (skill.companions.length > 0) {
    lines.push("", "同包文件：", ...skill.companions.map((file) => `- ${file}`));
  }
  return lines.join("\n");
}

function readLoadArgs(args: unknown): {
  name: string;
  args: string;
  error?: string;
} {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { name: "", args: "", error: "参数必须是对象" };
  }
  const record = args as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.trim()) {
    return { name: "", args: "", error: "缺少 name" };
  }
  const extra = record.args;
  return {
    name: record.name.trim(),
    args: typeof extra === "string" ? extra : "",
  };
}
