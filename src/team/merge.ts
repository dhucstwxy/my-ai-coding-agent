import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TeamRecord } from "./types.js";

const execFileAsync = promisify(execFile);

export interface MergeResult {
  ok: boolean;
  message: string;
}

/**
 * 将成员 worktree 分支合并进主仓库当前分支。
 * 冲突则 abort 并返回失败说明。
 */
export async function mergeMemberBranches(
  repoRoot: string,
  team: TeamRecord,
  memberNames: string[],
): Promise<MergeResult> {
  const members = team.members.filter(
    (m) => memberNames.includes(m.name) && m.workdir === "worktree" && m.worktreeName,
  );
  if (members.length === 0) {
    return { ok: false, message: "没有可合并的 worktree 成员" };
  }

  for (const m of members) {
    const branch = `mew/${m.worktreeName!.replace(/\//g, "__")}`;
    try {
      await git(repoRoot, ["merge", "--no-edit", branch]);
    } catch (err) {
      try {
        await git(repoRoot, ["merge", "--abort"]);
      } catch {
        // 可能不在合并中
      }
      return {
        ok: false,
        message: `合并「${m.name}」分支 ${branch} 冲突或失败，已回滚：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return {
    ok: true,
    message: `已合并：${members.map((m) => m.name).join(", ")}`,
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      encoding: "utf8",
    });
    return `${stdout ?? ""}${stderr ?? ""}`.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(e.stderr?.trim() || e.message || String(err));
  }
}
