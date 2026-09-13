import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { truncateText } from "./truncate.js";
import { assertWorkspacePath, matchGlob } from "./glob-files.js";

const MAX_HITS = 100;
const MAX_LINE_LEN = 200;

export const grepSearchTool: Tool = {
  name: "grep_search",
  description:
    "在工作区内按正则或字面文本搜索文件内容，返回匹配的文件路径、行号与片段。",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "搜索模式（正则）" },
      path: {
        type: "string",
        description: "可选，限制在某文件或目录下搜索",
      },
      glob: {
        type: "string",
        description: "可选，仅搜索匹配该 glob 的文件，如 **/*.ts",
      },
    },
    required: ["pattern"],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as {
      pattern?: unknown;
      path?: unknown;
      glob?: unknown;
    };
    if (typeof a?.pattern !== "string" || a.pattern === "") {
      return {
        ok: false,
        content: "参数 pattern 必须是非空字符串",
        errorCode: "invalid_args",
      };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(a.pattern, "g");
    } catch (err) {
      return {
        ok: false,
        content: `无效正则：${err instanceof Error ? err.message : String(err)}`,
        errorCode: "invalid_args",
      };
    }

    const scope =
      typeof a.path === "string"
        ? assertWorkspacePath(ctx.workspaceRoot, a.path)
        : assertWorkspacePath(ctx.workspaceRoot, undefined);
    if (!scope.ok) return scope.result;

    const fileGlob = typeof a.glob === "string" ? a.glob : undefined;
    if (fileGlob?.includes("..")) {
      return {
        ok: false,
        content: "glob 不得包含 ..",
        errorCode: "path_outside_workspace",
      };
    }

    const root = path.resolve(ctx.workspaceRoot);
    const hits: string[] = [];
    try {
      await searchTree(scope.absPath, root, regex, fileGlob, hits);
    } catch (err) {
      return {
        ok: false,
        content: `搜索失败：${err instanceof Error ? err.message : String(err)}`,
        errorCode: "invalid_args",
      };
    }

    if (hits.length === 0) {
      return { ok: true, content: "（无匹配）" };
    }
    const truncated = hits.length >= MAX_HITS;
    let content = hits.join("\n");
    if (truncated) {
      content += `\n\n…（已截断，最多 ${MAX_HITS} 条匹配）`;
    }
    return { ok: true, content: truncateText(content) };
  },
};

async function searchTree(
  start: string,
  root: string,
  regex: RegExp,
  fileGlob: string | undefined,
  hits: string[],
): Promise<void> {
  let st;
  try {
    st = await fs.stat(start);
  } catch {
    return;
  }

  if (st.isFile()) {
    await searchFile(start, root, regex, fileGlob, hits);
    return;
  }

  if (!st.isDirectory()) return;

  let entries;
  try {
    entries = await fs.readdir(start, { withFileTypes: true });
  } catch {
    return;
  }

  for (const ent of entries) {
    if (hits.length >= MAX_HITS) return;
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const abs = path.join(start, ent.name);
    if (ent.isDirectory()) {
      await searchTree(abs, root, regex, fileGlob, hits);
    } else if (ent.isFile()) {
      await searchFile(abs, root, regex, fileGlob, hits);
    }
  }
}

async function searchFile(
  abs: string,
  root: string,
  regex: RegExp,
  fileGlob: string | undefined,
  hits: string[],
): Promise<void> {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (fileGlob && !matchGlob(rel, fileGlob)) return;

  let text: string;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch {
    return;
  }
  // 跳过明显二进制
  if (text.includes("\0")) return;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (hits.length >= MAX_HITS) return;
    const line = lines[i];
    regex.lastIndex = 0;
    if (!regex.test(line)) continue;
    const snippet =
      line.length > MAX_LINE_LEN ? `${line.slice(0, MAX_LINE_LEN)}…` : line;
    hits.push(`${rel}:${i + 1}: ${snippet}`);
  }
}
