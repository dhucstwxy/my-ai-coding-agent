import type { MemberRecord } from "./types.js";

export const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

/** 需审批且未批准时，写类工具不可用。 */
export function assertWritable(member: MemberRecord): void {
  if (member.requiresApproval && !member.approved) {
    throw new Error(
      `队员「${member.name}」需要审批：请先向 Lead 发送 type=plan 的计划，获批后再改文件`,
    );
  }
}

export function applyApprovalMail(
  member: MemberRecord,
  type: string | undefined,
): MemberRecord {
  if (type === "approve") {
    return { ...member, approved: true };
  }
  if (type === "reject" || type === "plan") {
    // 新计划或驳回后重新进入未批准
    if (type === "reject") return { ...member, approved: false };
    if (type === "plan") return { ...member, approved: false };
  }
  return member;
}
