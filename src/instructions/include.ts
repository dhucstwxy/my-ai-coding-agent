import fs from "node:fs";
import path from "node:path";

export const INCLUDE_MAX_DEPTH = 5;

const INCLUDE_LINE = /^\s*@include\s+(\S+)\s*$/;

export interface ExpandIncludesOptions {
  rootDir: string;
  maxDepth?: number;
  visited?: Set<string>;
  depth?: number;
}

export interface ExpandIncludesResult {
  text: string;
  warnings: string[];
}

/** 解析相对路径，确保仍落在 rootDir 内；失败返回 null */
export function resolveSafe(rootDir: string, rel: string): string | null {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) {
    return null;
  }
  try {
    if (!fs.existsSync(candidate)) return null;
    const real = fs.realpathSync(candidate);
    const rootReal = fs.realpathSync(root);
    const rootRealSep = rootReal.endsWith(path.sep)
      ? rootReal
      : rootReal + path.sep;
    if (real !== rootReal && !real.startsWith(rootRealSep)) {
      return null;
    }
    return real;
  } catch {
    return null;
  }
}

/**
 * 展开正文中的整行 `@include <relpath>`。
 * 越界 / 环路 / 超深 / 缺失 → 跳过该行并记入 warnings。
 */
export function expandIncludes(
  content: string,
  opts: ExpandIncludesOptions,
): ExpandIncludesResult {
  const maxDepth = opts.maxDepth ?? INCLUDE_MAX_DEPTH;
  const depth = opts.depth ?? 0;
  const visited = opts.visited ?? new Set<string>();
  const warnings: string[] = [];
  const lines = content.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    const m = INCLUDE_LINE.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    if (depth >= maxDepth) {
      warnings.push(`@include 超过最大深度 ${maxDepth}，已跳过：${m[1]}`);
      continue;
    }
    const resolved = resolveSafe(opts.rootDir, m[1]);
    if (!resolved) {
      warnings.push(`@include 路径无效或越出根目录，已跳过：${m[1]}`);
      continue;
    }
    if (visited.has(resolved)) {
      warnings.push(`@include 检测到环路，已跳过：${m[1]}`);
      continue;
    }
    visited.add(resolved);
    let childRaw: string;
    try {
      childRaw = fs.readFileSync(resolved, "utf8");
    } catch (err) {
      warnings.push(
        `@include 读取失败（${m[1]}）：${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const child = expandIncludes(childRaw, {
      rootDir: opts.rootDir,
      maxDepth,
      visited,
      depth: depth + 1,
    });
    warnings.push(...child.warnings);
    out.push(child.text);
  }

  return { text: out.join("\n"), warnings };
}
