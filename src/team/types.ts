/** 小组与协作核心类型 */

export type MemberWorkdir = "worktree" | "main";
export type MemberBackend = "pane" | "inprocess";
export type MemberStatus = "running" | "idle" | "stopped";
export type TeamTaskStatus = "open" | "done" | "cancelled";
export type MailType = "idle" | "plan" | "approve" | "reject" | "text";

export interface MemberRecord {
  name: string;
  role: string;
  workdir: MemberWorkdir;
  worktreeName?: string;
  backend: MemberBackend;
  backendHandle?: string;
  requiresApproval: boolean;
  status: MemberStatus;
  approved: boolean;
}

export interface TeamRecord {
  name: string;
  leadName: string;
  rootPath: string;
  members: MemberRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamTask {
  id: string;
  title: string;
  description?: string;
  dependsOn: string[];
  assignee?: string;
  status: TeamTaskStatus;
}

export interface MailMessage {
  id: string;
  from: string;
  body: string;
  timestamp: string;
  read: boolean;
  summary: string;
  type?: MailType;
}

export interface MailDraft {
  from: string;
  body: string;
  summary?: string;
  type?: MailType;
}

export interface NameEntry {
  name: string;
  mailboxRel: string;
  backendHandle?: string;
}

export type NameValidation =
  | { ok: true; name: string }
  | { ok: false; reason: string };
