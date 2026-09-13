import fs from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { truncateText } from "./truncate.js";
import { resolveInWorkspace } from "./workspace.js";

export const readFileTool: Tool = {
  name: "read_file",
  sideEffect: false,
  description:
    "读取工作区内指定路径的文本文件内容。路径相对工作区根目录或为工作区内的绝对路径。",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "要读取的文件路径" },
    },
    required: ["path"],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const pathArg = (args as { path?: unknown })?.path;
    const resolved = resolveInWorkspace(ctx.workspaceRoot, pathArg);
    if (!resolved.ok) {
      return {
        ok: false,
        content: resolved.error,
        errorCode: resolved.errorCode,
      };
    }

    try {
      const text = await fs.readFile(resolved.absPath, "utf8");
      return { ok: true, content: truncateText(text) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          ok: false,
          content: `文件不存在：${String(pathArg)}`,
          errorCode: "not_found",
        };
      }
      return {
        ok: false,
        content: `读取失败：${err instanceof Error ? err.message : String(err)}`,
        errorCode: "invalid_args",
      };
    }
  },
};
