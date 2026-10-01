import { randomBytes } from "node:crypto";
import type { NameValidation } from "./types.js";

const SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;
const MAX_LENGTH = 64;
const MAX_SEGMENTS = 4;

/** 规范化分隔符为 `/`，去掉首尾斜杠。 */
export function normalizeName(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("/");
}

/**
 * 校验 worktree 逻辑名。
 * 单段字符集 [a-zA-Z0-9._-]，总长 ≤ 64，段数 ≤ 4，禁止 . / .. 段。
 */
export function validateName(raw: string): NameValidation {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "目录名为空" };
  }
  const name = normalizeName(raw);
  if (!name) {
    return { ok: false, reason: "目录名为空" };
  }
  if (name.length > MAX_LENGTH) {
    return { ok: false, reason: `目录名过长（最多 ${MAX_LENGTH}）` };
  }
  const segments = name.split("/");
  if (segments.length > MAX_SEGMENTS) {
    return { ok: false, reason: `目录名段数过多（最多 ${MAX_SEGMENTS}）` };
  }
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      return { ok: false, reason: "目录名不得包含 . 或 .. 段" };
    }
    if (!SEGMENT_RE.test(seg)) {
      return { ok: false, reason: `目录名含非法字符：${seg}` };
    }
  }
  return { ok: true, name };
}

/** 将逻辑名映射为 git 分支名：mew/<name>，其中 / 换成 __。 */
export function toBranchName(name: string): string {
  const v = validateName(name);
  if (!v.ok) {
    throw new Error(v.reason);
  }
  return `mew/${v.name.replace(/\//g, "__")}`;
}

/** 为隔离子 Agent 生成逻辑名：agents/<role>-<8hex>。 */
export function generateAgentWorktreeName(roleName: string): string {
  for (let i = 0; i < 8; i++) {
    const shortId = randomBytes(4).toString("hex");
    const candidate = `agents/${roleName}-${shortId}`;
    const v = validateName(candidate);
    if (v.ok) return v.name;
  }
  throw new Error("无法生成合法的 worktree 目录名");
}
