import type { Tool, ToolResult } from "../../tools/types.js";
import { wakePane } from "../backend.js";
import { isCoordinatorActive } from "../coordinator.js";
import type { AppConfig } from "../../config/types.js";
import { mergeMemberBranches } from "../merge.js";
import type { MemberRunner } from "../runner.js";
import { LEAD_NAME, type TeamStore } from "../store.js";
import { Mailbox, TeamRegistry } from "../mailbox.js";
import { TeamTaskStore } from "../tasks.js";
import type { MailType } from "../types.js";
import type { WorktreeService } from "../../worktree/index.js";

export interface TeamToolHost {
  store: TeamStore;
  runner: MemberRunner;
  worktrees: WorktreeService;
  repoRoot: string;
  config: AppConfig;
}

function ok(content: string): ToolResult {
  return { ok: true, content };
}

function fail(content: string): ToolResult {
  return { ok: false, content, errorCode: "team" };
}

function mailOf(host: TeamToolHost): Mailbox {
  const team = host.store.requireActive();
  const registry = new TeamRegistry(team.rootPath);
  return new Mailbox(team.rootPath, registry);
}

function tasksOf(host: TeamToolHost): TeamTaskStore {
  return new TeamTaskStore(host.store.requireActive().rootPath);
}

export function createLeadTeamTools(host: TeamToolHost): Tool[] {
  return [
    {
      name: "team_create",
      description: "创建或恢复长期小组（同名则恢复，不清空历史）。已有活跃小组时须先解散或停用。",
      sideEffect: true,
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "小组名" } },
        required: ["name"],
      },
      async execute(args) {
        try {
          const name = String((args as { name?: string }).name ?? "");
          const team = host.store.create(name);
          const registry = new TeamRegistry(team.rootPath);
          const mailbox = new Mailbox(team.rootPath, registry);
          mailbox.ensureMailbox(LEAD_NAME);
          registry.upsert({ name: LEAD_NAME, mailboxRel: `mail/${LEAD_NAME}.json` });
          return ok(`活跃小组：${team.name}（${team.rootPath}）`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "team_disband",
      description: "解散当前活跃小组并删除其持久化目录。",
      sideEffect: true,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        try {
          for (const m of host.store.listMembers()) {
            if (m.name !== LEAD_NAME && m.status === "running") {
              host.runner.stop(m.name);
            }
          }
          const name = host.store.active()?.name;
          host.store.disband();
          return ok(`已解散小组：${name ?? ""}`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "team_spawn",
      description: "派生成员。默认独立 worktree；可要求审批。",
      sideEffect: true,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          workdir: { type: "string", enum: ["worktree", "main"] },
          requiresApproval: { type: "boolean" },
        },
        required: ["name", "role"],
      },
      async execute(args) {
        try {
          const a = args as {
            name?: string;
            role?: string;
            workdir?: "worktree" | "main";
            requiresApproval?: boolean;
          };
          const member = await host.runner.spawn({
            name: String(a.name ?? ""),
            role: String(a.role ?? ""),
            ...(a.workdir ? { workdir: a.workdir } : {}),
            ...(a.requiresApproval !== undefined
              ? { requiresApproval: a.requiresApproval }
              : {}),
          });
          return ok(
            `已派生 ${member.name}（backend=${member.backend}, workdir=${member.workdir}, status=${member.status}）`,
          );
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "team_stop",
      description: "终止指定队员的当前运行。",
      sideEffect: true,
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      async execute(args) {
        try {
          const name = String((args as { name?: string }).name ?? "");
          const m = host.runner.stop(name);
          return ok(`已停止 ${m.name}，status=${m.status}`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "team_message",
      description:
        "向队员或 Lead 发消息。to 为名称，或 * 广播。type 可选 idle/plan/approve/reject/text。",
      sideEffect: true,
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          body: { type: "string" },
          type: {
            type: "string",
            enum: ["idle", "plan", "approve", "reject", "text"],
          },
          summary: { type: "string" },
        },
        required: ["to", "body"],
      },
      async execute(args) {
        return sendMessage(host, LEAD_NAME, args);
      },
    },
    {
      name: "team_task_list",
      description: "列出共享任务。",
      sideEffect: false,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        try {
          const list = tasksOf(host).list();
          return ok(JSON.stringify(list, null, 2));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "team_task_add",
      description: "添加共享任务，可带 dependsOn 与 assignee。",
      sideEffect: true,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
          assignee: { type: "string" },
        },
        required: ["title"],
      },
      async execute(args) {
        try {
          const a = args as {
            title?: string;
            description?: string;
            dependsOn?: string[];
            assignee?: string;
          };
          const task = tasksOf(host).add({
            title: String(a.title ?? ""),
            ...(a.description !== undefined
              ? { description: a.description }
              : {}),
            ...(a.dependsOn ? { dependsOn: a.dependsOn } : {}),
            ...(a.assignee ? { assignee: a.assignee } : {}),
          });
          return ok(JSON.stringify(task, null, 2));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "team_task_update",
      description: "更新共享任务字段。",
      sideEffect: true,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
          assignee: { type: "string" },
          status: { type: "string", enum: ["open", "done", "cancelled"] },
        },
        required: ["id"],
      },
      async execute(args) {
        try {
          const a = args as Record<string, unknown>;
          const id = String(a.id ?? "");
          const patch: Record<string, unknown> = {};
          for (const key of [
            "title",
            "description",
            "dependsOn",
            "assignee",
            "status",
          ]) {
            if (a[key] !== undefined) patch[key] = a[key];
          }
          const task = tasksOf(host).update(id, patch);
          return ok(JSON.stringify(task, null, 2));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "team_task_remove",
      description: "删除共享任务。",
      sideEffect: true,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      async execute(args) {
        try {
          const id = String((args as { id?: string }).id ?? "");
          const removed = tasksOf(host).remove(id);
          return removed ? ok(`已删除 ${id}`) : fail(`找不到任务 ${id}`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "team_merge",
      description: "将指定队员的 worktree 分支合并进主仓库；冲突则回滚。",
      sideEffect: true,
      inputSchema: {
        type: "object",
        properties: {
          members: { type: "array", items: { type: "string" } },
        },
        required: ["members"],
      },
      async execute(args) {
        try {
          const team = host.store.requireActive();
          const members = (args as { members?: string[] }).members ?? [];
          const result = await mergeMemberBranches(
            host.repoRoot,
            team,
            members,
          );
          return result.ok ? ok(result.message) : fail(result.message);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}

export function createMemberTeamTools(
  host: TeamToolHost,
  memberName: string,
): Tool[] {
  const leadTools = createLeadTeamTools(host);
  const allow = new Set([
    "team_message",
    "team_task_list",
    "team_task_add",
    "team_task_update",
    "team_task_remove",
  ]);
  return leadTools
    .filter((t) => allow.has(t.name))
    .map((t) => {
      if (t.name !== "team_message") return t;
      return {
        ...t,
        async execute(args: unknown) {
          return sendMessage(host, memberName, args);
        },
      };
    });
}

async function sendMessage(
  host: TeamToolHost,
  from: string,
  args: unknown,
): Promise<ToolResult> {
  try {
    const a = args as {
      to?: string;
      body?: string;
      type?: MailType;
      summary?: string;
    };
    const to = String(a.to ?? "");
    const body = String(a.body ?? "");
    if (!body.trim()) return fail("正文不能为空");
    const mailbox = mailOf(host);
    mailbox.ensureMailbox(LEAD_NAME);

    if (to === "*") {
      const n = await mailbox.broadcast(from, {
        body,
        ...(a.type ? { type: a.type } : {}),
        ...(a.summary ? { summary: a.summary } : {}),
      });
      return ok(`已广播，收件人 ${n} 人（已写入）`);
    }

    mailbox.ensureMailbox(to);
    const msg = await mailbox.send(to, {
      from,
      body,
      ...(a.type ? { type: a.type } : {}),
      ...(a.summary ? { summary: a.summary } : {}),
    });

    // Lead 发给队员的审批类消息更新队员 approved 标志
    if (
      from === LEAD_NAME &&
      to !== LEAD_NAME &&
      (a.type === "approve" || a.type === "reject" || a.type === "plan")
    ) {
      host.runner.applyMailType(to, a.type);
    }

    const target = host.store.getMember(to);
    let woken = false;
    if (target?.backend === "pane" && target.backendHandle) {
      woken = wakePane(target.backendHandle);
    }
    if (target?.status === "idle" && from === LEAD_NAME) {
      await host.runner.resume(to, body);
    }

    return ok(
      [
        `已写入 ${to} 邮箱 id=${msg.id}`,
        `唤醒：${woken ? "是" : "否"}`,
        isCoordinatorActive(host.config) ? "（Coordinator 已启用）" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
