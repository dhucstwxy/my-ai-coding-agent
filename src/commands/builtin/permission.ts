import type { PermissionMode } from "../../permission/types.js";
import type { CommandDefinition } from "../types.js";

const MODES = new Set<string>(["strict", "default", "allow"]);

function permissionLabel(mode: PermissionMode): string {
  if (mode === "strict") return "严格档";
  if (mode === "allow") return "放行档";
  return "默认档";
}

export const permissionCommand: CommandDefinition = {
  name: "permission",
  aliases: ["perm"],
  description: "切换权限档位 strict|default|allow；可带任务正文",
  usage: "/permission <strict|default|allow> [任务]",
  type: "ui",
  argsHint: "strict|default|allow [任务]",
  async handler(ctx, args) {
    const trimmed = args.trim();
    if (!trimmed) {
      ctx.ui.showMessage(
        "用法：/permission <strict|default|allow> [任务]\n别名：/perm",
      );
      return;
    }
    const space = trimmed.indexOf(" ");
    const modeStr = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
    const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();

    if (!MODES.has(modeStr)) {
      ctx.ui.showMessage(
        `无效权限档「${modeStr}」。用法：/permission <strict|default|allow> [任务]`,
      );
      return;
    }

    const mode = modeStr as PermissionMode;
    ctx.ui.setPermissionMode(mode);
    if (!rest) {
      ctx.ui.showMessage(`已切换为${permissionLabel(mode)}。`);
      return;
    }
    await ctx.ui.submitToAgent(rest);
  },
};
