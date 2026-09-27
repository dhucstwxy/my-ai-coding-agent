import type { CommandDefinition } from "../types.js";

export const planCommand: CommandDefinition = {
  name: "plan",
  description: "进入计划模式（只读工具）；可带任务正文",
  usage: "/plan [任务]",
  type: "ui",
  argsHint: "可选任务正文",
  async handler(ctx, args) {
    ctx.ui.setAgentMode("plan");
    if (!args) {
      ctx.ui.showMessage(
        "已切换为计划模式。当前仅开放只读工具（read_file / glob_files / grep_search）。",
      );
      return;
    }
    await ctx.ui.submitToAgent(args);
  },
};
