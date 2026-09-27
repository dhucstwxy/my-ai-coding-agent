import type { CommandDefinition } from "../types.js";

export const memoryCommand: CommandDefinition = {
  name: "memory",
  description: "显示项目/用户记忆 INDEX 概况",
  usage: "/memory",
  type: "local",
  handler(ctx) {
    const scopes = ctx.getMemoryInfo();
    const lines = ["记忆 INDEX："];
    for (const s of scopes) {
      if (!s.exists) {
        lines.push(`  [${s.scope}] 不存在：${s.path}`);
        continue;
      }
      lines.push(
        `  [${s.scope}] ${s.path}`,
        `    行数：${s.lineCount ?? 0}　大小：${s.byteSize ?? 0} 字节`,
      );
    }
    ctx.ui.showMessage(lines.join("\n"));
  },
};
