import { parseInput } from "./parse.js";
import type { CommandRegistry } from "./registry.js";
import type { CommandContext, DispatchResult } from "./types.js";

/** 解析 → 查找 → 执行；非命令返回 handled:false */
export async function dispatch(
  raw: string,
  ctx: CommandContext,
  registry: CommandRegistry,
): Promise<DispatchResult> {
  const parsed = parseInput(raw);

  if (parsed.kind === "empty") {
    return { handled: true };
  }

  if (parsed.kind === "not_command") {
    return { handled: false, text: parsed.text };
  }

  const def = registry.get(parsed.name);
  if (!def) {
    return { handled: true, unknown: true, name: parsed.name };
  }

  await def.handler(ctx, parsed.args);
  return { handled: true };
}
