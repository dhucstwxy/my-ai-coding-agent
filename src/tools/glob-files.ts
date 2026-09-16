import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { truncateText } from "./truncate.js";
import { resolveInWorkspace } from "./workspace.js";

const MAX_MATCHES = 500;

export const globFilesTool: Tool = {
  name: "glob_files",
  sideEffect: false,
  description:
    "在工作区内按 glob 模式查找文件路径（支持 * 与 **）。返回相对工作区根的路径列表。优先使用本专用工具找文件，不要用 find/dir/ls 代替。",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "glob 模式，如 **/*.ts 或 src/**/*.tsx",
      },
    },
    required: ["pattern"],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const pattern = (args as { pattern?: unknown })?.pattern;
    if (typeof pattern !== "string" || pattern.trim() === "") {
      return {
        ok: false,
        content: "参数 pattern 必须是非空字符串",
        errorCode: "invalid_args",
      };
    }

    // 禁止明显越界的模式前缀
    if (pattern.includes("..")) {
      return {
        ok: false,
        content: "pattern 不得包含 ..",
        errorCode: "path_outside_workspace",
      };
    }

    try {
      const root = path.resolve(ctx.workspaceRoot);
      const matches: string[] = [];
      await walkMatch(root, root, pattern, matches);

      const truncated = matches.length > MAX_MATCHES;
      const slice = matches.slice(0, MAX_MATCHES);
      let content =
        slice.length === 0
          ? "（无匹配文件）"
          : slice.map((p) => path.relative(root, p).split(path.sep).join("/")).join("\n");
      if (truncated) {
        content += `\n\n…（已截断，仅显示前 ${MAX_MATCHES} 条，共 ${matches.length} 条）`;
      }
      return { ok: true, content: truncateText(content) };
    } catch (err) {
      return {
        ok: false,
        content: `查找失败：${err instanceof Error ? err.message : String(err)}`,
        errorCode: "invalid_args",
      };
    }
  },
};

async function walkMatch(
  root: string,
  dir: string,
  pattern: string,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const ent of entries) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const abs = path.join(dir, ent.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (ent.isDirectory()) {
      await walkMatch(root, abs, pattern, out);
    } else if (ent.isFile() && matchGlob(rel, pattern)) {
      out.push(abs);
    }
  }
}

/** 简易 glob：支持 *、** 与 ? */
export function matchGlob(relPath: string, pattern: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  const pat = pattern.replace(/\\/g, "/");
  const regex = globToRegExp(pat);
  return regex.test(norm);
}

function globToRegExp(pattern: string): RegExp {
  let i = 0;
  let out = "^";
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
      continue;
    }
    if (c === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if ("+.^${}()|[]\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

/** 供 grep 限制扫描范围时复用路径检查 */
export function assertWorkspacePath(
  workspaceRoot: string,
  userPath: string | undefined,
): { ok: true; absPath: string } | { ok: false; result: ToolResult } {
  if (userPath === undefined || userPath === "") {
    return { ok: true, absPath: path.resolve(workspaceRoot) };
  }
  const resolved = resolveInWorkspace(workspaceRoot, userPath);
  if (!resolved.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        content: resolved.error,
        errorCode: resolved.errorCode,
      },
    };
  }
  return { ok: true, absPath: resolved.absPath };
}
