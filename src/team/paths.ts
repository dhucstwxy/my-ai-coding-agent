import os from "node:os";
import path from "node:path";
import type { NameValidation } from "./types.js";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

/** 用户小组根：~/.mewcode/teams */
export function userTeamsDir(home = os.homedir()): string {
  return path.join(home, ".mewcode", "teams");
}

export function validateTeamName(raw: string): NameValidation {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "小组名为空" };
  }
  const name = raw.trim();
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return { ok: false, reason: "小组名不得含路径段" };
  }
  if (name === "." || name === "..") {
    return { ok: false, reason: "小组名不合法" };
  }
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      reason: "小组名仅允许字母数字开头，后接字母数字下划线连字符，最长 63",
    };
  }
  return { ok: true, name };
}

export function validateMemberName(raw: string): NameValidation {
  return validateTeamName(raw);
}

export function teamRoot(teamName: string, home = os.homedir()): string {
  const v = validateTeamName(teamName);
  if (!v.ok) throw new Error(v.reason);
  return path.join(userTeamsDir(home), v.name);
}

export function teamJsonPath(root: string): string {
  return path.join(root, "team.json");
}

export function tasksJsonPath(root: string): string {
  return path.join(root, "tasks.json");
}

export function registryJsonPath(root: string): string {
  return path.join(root, "registry.json");
}

export function mailDir(root: string): string {
  return path.join(root, "mail");
}

export function mailboxPath(root: string, memberName: string): string {
  const v = validateMemberName(memberName);
  if (!v.ok) throw new Error(v.reason);
  return path.join(mailDir(root), `${v.name}.json`);
}

export function mailboxLockPath(root: string, memberName: string): string {
  const v = validateMemberName(memberName);
  if (!v.ok) throw new Error(v.reason);
  return path.join(mailDir(root), `${v.name}.lock`);
}

export function memberSessionDir(root: string, memberName: string): string {
  const v = validateMemberName(memberName);
  if (!v.ok) throw new Error(v.reason);
  return path.join(root, "members", v.name, "session");
}
