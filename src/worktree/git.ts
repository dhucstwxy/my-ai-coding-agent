import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60_000;

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

async function git(
  cwd: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
    return out;
  } catch (err) {
    const e = err as {
      message?: string;
      stderr?: string;
      stdout?: string;
    };
    const detail =
      (e.stderr && String(e.stderr).trim()) ||
      (e.stdout && String(e.stdout).trim()) ||
      e.message ||
      String(err);
    throw new GitError(`git ${args.join(" ")} 失败：${detail}`);
  }
}

/** 从当前 HEAD 新建分支并添加 worktree。 */
export async function worktreeAdd(
  repoRoot: string,
  absPath: string,
  branch: string,
): Promise<void> {
  await git(repoRoot, ["worktree", "add", "-b", branch, absPath]);
}

/** 移除 worktree 登记（并删除目录，若仍在）。 */
export async function worktreeRemove(
  repoRoot: string,
  absPath: string,
): Promise<void> {
  try {
    await git(repoRoot, ["worktree", "remove", "--force", absPath]);
  } catch (err) {
    // 目录已不在登记中时，尝试 prune
    await git(repoRoot, ["worktree", "prune"]);
    throw err;
  }
}

export interface ListedWorktree {
  path: string;
  branch?: string;
}

/** 解析 `git worktree list --porcelain`。 */
export async function worktreeList(repoRoot: string): Promise<ListedWorktree[]> {
  const raw = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!raw) return [];
  const items: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) items.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ") && current) {
      const ref = line.slice("branch ".length);
      current.branch = ref.replace(/^refs\/heads\//, "");
    } else if (line === "" && current) {
      items.push(current);
      current = null;
    }
  }
  if (current) items.push(current);
  return items;
}

/** 返回 porcelain 状态文本；空串表示干净。 */
export async function statusPorcelain(worktreePath: string): Promise<string> {
  return git(worktreePath, ["status", "--porcelain"]);
}

/** 当前 HEAD commit。 */
export async function revParseHead(worktreePath: string): Promise<string> {
  const sha = await git(worktreePath, ["rev-parse", "HEAD"]);
  return sha.split(/\r?\n/)[0]?.trim() ?? "";
}

/**
 * 是否有未推送的本地 commit。
 * 有上游则比 @{upstream}；无上游且提供 baselineSha 则比 baseline..HEAD。
 */
export async function hasUnpushed(
  worktreePath: string,
  baselineSha?: string,
): Promise<boolean> {
  try {
    const out = await git(worktreePath, [
      "rev-list",
      "--count",
      "@{upstream}..HEAD",
    ]);
    const n = Number.parseInt(out.split(/\r?\n/)[0]?.trim() ?? "0", 10);
    return Number.isFinite(n) && n > 0;
  } catch {
    if (!baselineSha) return false;
    const out = await git(worktreePath, [
      "rev-list",
      "--count",
      `${baselineSha}..HEAD`,
    ]);
    const n = Number.parseInt(out.split(/\r?\n/)[0]?.trim() ?? "0", 10);
    return Number.isFinite(n) && n > 0;
  }
}

/** 读取主仓或 worktree 的 hooksPath（可能为空）。 */
export async function getHooksPath(repoOrWorktree: string): Promise<string> {
  try {
    const out = await git(repoOrWorktree, ["config", "--get", "core.hooksPath"]);
    return out.split(/\r?\n/)[0]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** 为指定 worktree 设置 core.hooksPath（local）。 */
export async function setHooksPath(
  worktreePath: string,
  hooksPath: string,
): Promise<void> {
  await git(worktreePath, ["config", "core.hooksPath", hooksPath]);
}
