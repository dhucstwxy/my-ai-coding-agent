import type { AgentMode } from "../../agent/types.js";
import type { PermissionMode } from "../../permission/types.js";
import type { CommandDefinition } from "../types.js";

function agentMark(mode: AgentMode): string {
  return mode === "plan" ? "PLAN" : "DEFAULT";
}

function permMark(mode: PermissionMode): string {
  if (mode === "strict") return "STRICT";
  if (mode === "allow") return "ALLOW";
  return "DEFAULT";
}

export const statusCommand: CommandDefinition = {
  name: "status",
  description: "一屏汇总模式、权限、会话与压缩状态",
  usage: "/status",
  type: "local",
  handler(ctx) {
    const s = ctx.ui.getStatusSnapshot();
    const lines = [
      "状态：",
      `  模式：[${agentMark(s.agentMode)}]　权限：[${permMark(s.permissionMode)}]`,
      `  会话：${s.sessionTitle}（${s.sessionId}）`,
      `  消息数：${s.messageCount}`,
      `  路径：${s.sessionPath}`,
      `  压缩熔断：${s.compactCircuitOpen ? "已打开" : "关闭"}`,
    ];
    if (s.tokenUsage) {
      const u = s.tokenUsage;
      lines.push(
        `  Token：输入 ${u.inputTokens ?? "—"} / 输出 ${u.outputTokens ?? "—"}`,
      );
      if (u.cacheAvailable) {
        lines.push(
          `  缓存：命中 ${u.cacheHitTokens ?? 0} / 未命中 ${u.cacheMissTokens ?? 0}`,
        );
      } else {
        lines.push("  缓存：不可用（协议未返回）");
      }
    } else {
      lines.push("  Token/缓存：尚无数据");
    }
    ctx.ui.showMessage(lines.join("\n"));
  },
};
