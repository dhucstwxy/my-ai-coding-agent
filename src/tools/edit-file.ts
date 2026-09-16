import fs from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { resolveInWorkspace } from "./workspace.js";

export const editFileTool: Tool = {
  name: "edit_file",
  sideEffect: true,
  description:
    "对工作区内已有文件做原文唯一匹配替换：old_text 必须在文件中恰好出现一次，否则返回错误且不改写文件。编辑前必须先 read_file。优先使用本专用工具改文件，不要用 sed/脚本代替。",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "要修改的文件路径" },
      old_text: { type: "string", description: "要被替换的原文（须唯一）" },
      new_text: { type: "string", description: "替换后的新文本" },
    },
    required: ["path", "old_text", "new_text"],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as {
      path?: unknown;
      old_text?: unknown;
      new_text?: unknown;
    };
    if (typeof a?.old_text !== "string" || typeof a?.new_text !== "string") {
      return {
        ok: false,
        content: "参数 old_text 与 new_text 必须是字符串",
        errorCode: "invalid_args",
      };
    }
    if (a.old_text.length === 0) {
      return {
        ok: false,
        content: "参数 old_text 不能为空",
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

    let original: string;
    try {
      original = await fs.readFile(resolved.absPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          ok: false,
          content: `文件不存在：${String(a.path)}`,
          errorCode: "not_found",
        };
      }
      return {
        ok: false,
        content: `读取失败：${err instanceof Error ? err.message : String(err)}`,
        errorCode: "invalid_args",
      };
    }

    const count = countOccurrences(original, a.old_text);
    if (count === 0) {
      return {
        ok: false,
        content: "未找到匹配的 old_text，文件未修改。请提供文件中恰好出现一次的原文片段。",
        errorCode: "edit_no_match",
      };
    }
    if (count > 1) {
      return {
        ok: false,
        content: `old_text 在文件中出现 ${count} 次，要求恰好一次。请提供更长、更唯一的原文片段。文件未修改。`,
        errorCode: "edit_multiple_matches",
      };
    }

    const updated = original.replace(a.old_text, a.new_text);
    try {
      await fs.writeFile(resolved.absPath, updated, "utf8");
      return {
        ok: true,
        content: `已替换 ${String(a.path)} 中的唯一匹配片段`,
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

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}
