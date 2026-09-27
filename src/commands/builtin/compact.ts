import type { CommandDefinition } from "../types.js";

export const compactCommand: CommandDefinition = {
  name: "compact",
  description: "手动压缩上下文；可带备注",
  usage: "/compact [备注]",
  type: "local",
  argsHint: "可选备注",
  async handler(ctx, args) {
    await ctx.runCompact(args);
  },
};
