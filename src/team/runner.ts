import fs from "node:fs";
import path from "node:path";
import type { WorktreeService } from "../worktree/index.js";
import { generateAgentWorktreeName } from "../worktree/name.js";
import { applyApprovalMail } from "./approval.js";
import {
  selectBackend,
  spawnTmuxPane,
  wakePane,
  type BackendSelectOptions,
} from "./backend.js";
import { LEAD_NAME, type TeamStore } from "./store.js";
import { Mailbox, TeamRegistry } from "./mailbox.js";
import { memberSessionDir, validateMemberName } from "./paths.js";
import type { MemberRecord, MemberWorkdir } from "./types.js";

export interface SpawnSpec {
  name: string;
  role: string;
  workdir?: MemberWorkdir;
  requiresApproval?: boolean;
  /** 测试：强制 pane 失败 */
  backendOpts?: BackendSelectOptions;
}

export interface MemberLoopContext {
  teamName: string;
  member: MemberRecord;
  workspaceRoot: string;
  sessionDir: string;
  abortSignal: AbortSignal;
}

export interface MemberRunnerDeps {
  repoRoot: string;
  worktrees: WorktreeService;
  /** 注入真循环；缺省则立即自然空闲（便于无模型验证） */
  runLoop?: (ctx: MemberLoopContext) => Promise<void>;
}

interface LiveMember {
  abort: AbortController;
  backend: "pane" | "inprocess";
  handle?: string;
}

export class MemberRunner {
  private readonly live = new Map<string, LiveMember>();

  constructor(
    private readonly store: TeamStore,
    private readonly deps: MemberRunnerDeps,
  ) {}

  helpers(teamRoot: string): { registry: TeamRegistry; mailbox: Mailbox } {
    const registry = new TeamRegistry(teamRoot);
    const mailbox = new Mailbox(teamRoot, registry);
    return { registry, mailbox };
  }

  async spawn(spec: SpawnSpec): Promise<MemberRecord> {
    const team = this.store.requireActive();
    const v = validateMemberName(spec.name);
    if (!v.ok) throw new Error(v.reason);
    if (v.name === LEAD_NAME) throw new Error("不能使用保留名 lead");
    if (team.members.some((m) => m.name === v.name && m.status === "running")) {
      throw new Error(`队员「${v.name}」已在运行`);
    }

    const backend = selectBackend(spec.backendOpts);
    const workdir = spec.workdir ?? "worktree";
    let worktreeName: string | undefined;
    let workspaceRoot = this.deps.repoRoot;

    if (workdir === "worktree") {
      worktreeName = generateAgentWorktreeName(v.name);
      const info = await this.deps.worktrees.create(worktreeName);
      this.deps.worktrees.enter(worktreeName);
      workspaceRoot = info.path;
    }

    const sessionDir = memberSessionDir(team.rootPath, v.name);
    fs.mkdirSync(sessionDir, { recursive: true });

    const member: MemberRecord = {
      name: v.name,
      role: spec.role,
      workdir,
      ...(worktreeName ? { worktreeName } : {}),
      backend,
      requiresApproval: spec.requiresApproval === true,
      status: "running",
      approved: spec.requiresApproval !== true,
    };

    let handle: string | undefined;
    if (backend === "pane") {
      handle = spawnTmuxPane(
        `echo "mewcode-team-member ${team.name}/${v.name}" && sleep infinity`,
        workspaceRoot,
      );
      member.backendHandle = handle;
    }

    const { registry, mailbox } = this.helpers(team.rootPath);
    mailbox.ensureMailbox(LEAD_NAME);
    mailbox.ensureMailbox(v.name);
    registry.upsert({
      name: v.name,
      mailboxRel: `mail/${v.name}.json`,
      ...(handle ? { backendHandle: handle } : {}),
    });

    this.store.upsertMember(member);
    writeSessionMeta(sessionDir, { workspaceRoot, teamName: team.name });

    const abort = new AbortController();
    this.live.set(v.name, { abort, backend, handle });

    void this.runMember(member, workspaceRoot, sessionDir, abort.signal);
    return member;
  }

  async resume(memberName: string, wakeBody: string): Promise<MemberRecord> {
    const team = this.store.requireActive();
    const member = this.store.getMember(memberName);
    if (!member) throw new Error(`找不到队员：${memberName}`);
    if (member.status === "running") {
      throw new Error(`队员「${memberName}」仍在运行`);
    }

    const sessionDir = memberSessionDir(team.rootPath, member.name);
    const meta = readSessionMeta(sessionDir);
    if (!meta) {
      throw new Error(`无法恢复「${memberName}」：缺少会话快照`);
    }

    let workspaceRoot = meta.workspaceRoot;
    if (member.workdir === "worktree" && member.worktreeName) {
      const info = this.deps.worktrees.enter(member.worktreeName);
      workspaceRoot = info.path;
    }

    const { mailbox } = this.helpers(team.rootPath);
    await mailbox.send(member.name, {
      from: LEAD_NAME,
      body: wakeBody,
      type: "text",
      summary: "恢复指派",
    });
    if (member.backend === "pane" && member.backendHandle) {
      wakePane(member.backendHandle);
    }

    const next = { ...member, status: "running" as const };
    this.store.upsertMember(next);
    appendSessionWake(sessionDir, wakeBody);

    const abort = new AbortController();
    this.live.set(member.name, {
      abort,
      backend: member.backend,
      handle: member.backendHandle,
    });
    void this.runMember(next, workspaceRoot, sessionDir, abort.signal);
    return next;
  }

  stop(memberName: string): MemberRecord {
    const member = this.store.getMember(memberName);
    if (!member) throw new Error(`找不到队员：${memberName}`);
    const live = this.live.get(memberName);
    live?.abort.abort();
    this.live.delete(memberName);
    if (member.workdir === "worktree" && member.worktreeName) {
      try {
        this.deps.worktrees.exit(member.worktreeName);
      } catch {
        // ignore
      }
    }
    const next = { ...member, status: "stopped" as const };
    this.store.upsertMember(next);
    return next;
  }

  /** Lead 收到 approve/reject/plan 时更新队员审批状态 */
  applyMailType(memberName: string, type: string | undefined): void {
    const member = this.store.getMember(memberName);
    if (!member) return;
    const next = applyApprovalMail(member, type);
    this.store.upsertMember(next);
  }

  private async runMember(
    member: MemberRecord,
    workspaceRoot: string,
    sessionDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    const team = this.store.requireActive();
    try {
      if (this.deps.runLoop) {
        await this.deps.runLoop({
          teamName: team.name,
          member,
          workspaceRoot,
          sessionDir,
          abortSignal: signal,
        });
      } else if (!signal.aborted) {
        // 无模型桩：立即自然结束
        await Promise.resolve();
      }
    } catch {
      // 循环错误仍进入空闲通知
    } finally {
      this.live.delete(member.name);
      if (member.workdir === "worktree" && member.worktreeName) {
        try {
          this.deps.worktrees.exit(member.worktreeName);
        } catch {
          // ignore
        }
      }
      const latest = this.store.getMember(member.name) ?? member;
      if (latest.status === "stopped") return;
      const idle = { ...latest, status: "idle" as const };
      this.store.upsertMember(idle);
      const { mailbox } = this.helpers(team.rootPath);
      mailbox.ensureMailbox(LEAD_NAME);
      try {
        await mailbox.send(LEAD_NAME, {
          from: idle.name,
          body: `队员 ${idle.name} 已空闲`,
          type: "idle",
          summary: `${idle.name} idle`,
        });
      } catch {
        // ignore
      }
    }
  }
}

function writeSessionMeta(
  sessionDir: string,
  meta: { workspaceRoot: string; teamName: string },
): void {
  fs.writeFileSync(
    path.join(sessionDir, "meta.json"),
    JSON.stringify(meta, null, 2) + "\n",
    "utf8",
  );
}

function readSessionMeta(
  sessionDir: string,
): { workspaceRoot: string; teamName: string } | null {
  const file = path.join(sessionDir, "meta.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as {
    workspaceRoot: string;
    teamName: string;
  };
}

function appendSessionWake(sessionDir: string, body: string): void {
  const file = path.join(sessionDir, "wakes.jsonl");
  fs.appendFileSync(
    file,
    JSON.stringify({ at: new Date().toISOString(), body }) + "\n",
    "utf8",
  );
}
