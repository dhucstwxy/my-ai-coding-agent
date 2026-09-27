import type { CommandDefinition } from "../types.js";

export const clearCommand: CommandDefinition = {
  name: "clear",
  description: "清空当前界面消息（不改会话存档）",
  usage: "/clear",
  type: "ui",
  handler(ctx) {
    ctx.ui.clearScreen();
  },
};
