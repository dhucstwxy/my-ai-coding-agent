import fs from "node:fs";
import path from "node:path";
import { getHooksPath, setHooksPath } from "./git.js";

const COPY_RELATIVE = [
  path.join(".mewcode", "config.yaml"),
  path.join(".mewcode", "permissions.local.yaml"),
  path.join(".mewcode", "hooks.local.yaml"),
] as const;

/**
 * 按固定规则初始化 worktree 环境。
 * 已存在的目标不覆盖；缺失则补齐。软链失败抛错。
 */
export async function initializeWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  for (const rel of COPY_RELATIVE) {
    const src = path.join(repoRoot, rel);
    const dest = path.join(worktreePath, rel);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  const mainHooks = await getHooksPath(repoRoot);
  if (mainHooks) {
    const absoluteHooks = path.isAbsolute(mainHooks)
      ? mainHooks
      : path.resolve(repoRoot, mainHooks);
    await setHooksPath(worktreePath, absoluteHooks);
  }

  const srcModules = path.join(repoRoot, "node_modules");
  const destModules = path.join(worktreePath, "node_modules");
  if (fs.existsSync(srcModules) && !fs.existsSync(destModules)) {
    // Windows 用 junction；Linux/macOS（含 Docker 镜像）用目录软链
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(srcModules, destModules, linkType);
  }
}
