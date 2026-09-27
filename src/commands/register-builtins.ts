import { clearCommand } from "./builtin/clear.js";
import { compactCommand } from "./builtin/compact.js";
import { doCommand } from "./builtin/do.js";
import { createHelpCommand } from "./builtin/help.js";
import { memoryCommand } from "./builtin/memory.js";
import { permissionCommand } from "./builtin/permission.js";
import { planCommand } from "./builtin/plan.js";
import { reviewCommand } from "./builtin/review.js";
import { sessionCommand } from "./builtin/session.js";
import { statusCommand } from "./builtin/status.js";
import { CommandRegistry } from "./registry.js";

/** 构建并注册全部十个内置命令 */
export function buildDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  const help = createHelpCommand(() => registry.listVisible());

  for (const def of [
    help,
    compactCommand,
    clearCommand,
    planCommand,
    doCommand,
    sessionCommand,
    memoryCommand,
    permissionCommand,
    statusCommand,
    reviewCommand,
  ]) {
    registry.register(def);
  }

  return registry;
}
