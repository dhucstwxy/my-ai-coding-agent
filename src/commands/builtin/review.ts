import type { CommandDefinition } from "../types.js";

/** 固定审查提示，作为用户消息送入 AI */
export const REVIEW_PROMPT =
  "请审查当前会话与近期工作：指出潜在风险、错误与可改进点，并给出具体建议。";

export const reviewCommand: CommandDefinition = {
  name: "review",
  description: "请模型审查当前会话并给出风险与建议",
  usage: "/review",
  type: "prompt",
  async handler(ctx) {
    await ctx.ui.submitToAgent(REVIEW_PROMPT);
  },
};
