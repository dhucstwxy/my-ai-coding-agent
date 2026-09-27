import type { CommandDefinition } from "../types.js";

export const sessionCommand: CommandDefinition = {
  name: "session",
  description: "显示当前会话信息",
  usage: "/session",
  type: "local",
  handler(ctx) {
    const info = ctx.getSessionInfo();
    if (!info) {
      ctx.ui.showMessage("当前会话不存在。");
      return;
    }
    ctx.ui.showMessage(
      [
        "会话信息：",
        `  ID：${info.id}`,
        `  标题：${info.title}`,
        `  消息数：${info.messageCount}`,
        `  路径：${info.path}`,
      ].join("\n"),
    );
  },
};
