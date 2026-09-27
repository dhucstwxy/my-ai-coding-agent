import type { CommandDefinition } from "../types.js";

export const doCommand: CommandDefinition = {
  name: "do",
  description: "退回执行模式；可带任务正文",
  usage: "/do [任务]",
  type: "ui",
  argsHint: "可选任务正文",
  async handler(ctx, args) {
    ctx.ui.setAgentMode("execute");
    if (!args) {
      ctx.ui.showMessage("已切换为执行模式。已恢复全部工具。");
      return;
    }
    await ctx.ui.submitToAgent(args);
  },
};
