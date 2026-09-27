import type { CommandDefinition } from "../types.js";

/** 带 registry 列表的 help 工厂 */
export function createHelpCommand(
  listVisible: () => CommandDefinition[],
): CommandDefinition {
  return {
    name: "help",
    description: "列出可用斜杠命令",
    usage: "/help",
    type: "local",
    handler(ctx) {
      const cmds = listVisible();
      const lines = [
        "可用命令：",
        ...cmds.map((c) => {
          const alias =
            c.aliases && c.aliases.length > 0
              ? `（别名：${c.aliases.map((a) => `/${a}`).join(", ")}）`
              : "";
          return `  /${c.name}${alias}\n    ${c.description}\n    用法：${c.usage}`;
        }),
      ];
      ctx.ui.showMessage(lines.join("\n"));
    },
  };
}
