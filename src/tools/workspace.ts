import fs from "node:fs";
import path from "node:path";

export type ResolveOk = { ok: true; absPath: string };
export type ResolveErr = {
  ok: false;
  error: string;
  errorCode: "path_outside_workspace" | "invalid_args";
};
export type ResolveResult = ResolveOk | ResolveErr;

/**
 * 将用户路径解析到工作区内；越界则失败。
 */
export function resolveInWorkspace(
  workspaceRoot: string,
  userPath: unknown,
): ResolveResult {
  if (typeof userPath !== "string" || userPath.trim() === "") {
    return {
      ok: false,
      error: "参数 path 必须是非空字符串",
      errorCode: "invalid_args",
    };
  }

  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(root, userPath);

  if (!isPathInsideRoot(candidate, root)) {
    return {
      ok: false,
      error: `路径越界工作区：${userPath}`,
      errorCode: "path_outside_workspace",
    };
  }

  // 若路径已存在，用 realpath 检测符号链接逃逸
  try {
    if (fs.existsSync(candidate)) {
      const real = fs.realpathSync(candidate);
      const realRoot = fs.realpathSync(root);
      if (!isPathInsideRoot(real, realRoot)) {
        return {
          ok: false,
          error: `路径经符号链接后越界工作区：${userPath}`,
          errorCode: "path_outside_workspace",
        };
      }
      return { ok: true, absPath: real };
    }
  } catch {
    return {
      ok: false,
      error: `无法确认路径仍在项目内：${userPath}`,
      errorCode: "path_outside_workspace",
    };
  }

  return { ok: true, absPath: candidate };
}

function isPathInsideRoot(absPath: string, root: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedPath = path.resolve(absPath);
  const rel = path.relative(normalizedRoot, normalizedPath);
  if (rel === "") return true;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}
