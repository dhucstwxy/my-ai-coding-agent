import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { resolveInWorkspace } from "./workspace.js";

export const writeFileTool: Tool = {
  name: "write_file",
  sideEffect: true,
  description:
    "在工作区内创建或覆盖写入文本文件。必要时自动创建中间目录。优先使用本专用工具写文件，不要用 shell 重定向代替。覆盖已有文件前必须先 read_file。",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "要写入的文件路径" },
      content: { type: "string", description: "要写入的文本内容" },
    },
    required: ["path", "content"],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as { path?: unknown; content?: unknown };
    if (typeof a?.content !== "string") {
      return {
        ok: false,
        content: "参数 content 必须是字符串",
        errorCode: "invalid_args",
      };
    }

    const resolved = resolveInWorkspace(ctx.workspaceRoot, a.path);
    if (!resolved.ok) {
      return {
        ok: false,
        content: resolved.error,
        errorCode: resolved.errorCode,
      };
    }

    try {
      await fs.mkdir(path.dirname(resolved.absPath), { recursive: true });
      await fs.writeFile(resolved.absPath, a.content, "utf8");
      return {
        ok: true,
        content: `已写入 ${String(a.path)}（${a.content.length} 字符）`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `写入失败：${err instanceof Error ? err.message : String(err)}`,
        errorCode: "invalid_args",
      };
    }
  },
};
