import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentLoop } from "../agent/loop.js";
import { createCancelToken, type CancelToken } from "../agent/cancel.js";
import type { AgentLoopOptions } from "../agent/types.js";
import type { ProviderConfig } from "../config/types.js";
import { ContextPipeline } from "../context/pipeline.js";
import type { HookEngine } from "../hooks/engine.js";
import type { HookSessionState } from "../hooks/state.js";
import type { PermissionGate } from "../permission/gate.js";
import type { PermissionModeStore } from "../permission/mode-store.js";
import type { PermissionMode } from "../permission/types.js";
import { createProvider } from "../provider/factory.js";
import type { ChatProvider } from "../provider/types.js";
import { SessionStore } from "../session/store.js";
import type { ChatMessage } from "../session/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import { TaskBoard } from "./board.js";
import { visibleTools } from "./tools.js";
import type {
  AgentCatalog,
} from "./catalog.js";
import type {
  AgentKind,
  AgentRecord,
  RequestSnapshot,
  SubAgentNotify,
  SubAgentStatus,
  SubAgentTask,
} from "./types.js";
import {
  generateAgentWorktreeName,
  type WorktreeService,
} from "../worktree/index.js";

/** 前台实际运行达到此时长就转入后台。权限确认期间不计。 */
export const FOREGROUND_LIMIT_MS = 60_000;

export interface SubAgentDeps {
  workspaceRoot: string;
  catalog: AgentCatalog;
  board: TaskBoard;
  registry: ToolRegistry;
  gate: PermissionGate;
  permissionModes: PermissionModeStore;
  providers: ProviderConfig[];
  parentProvider: ChatProvider;
  parentConfig: ProviderConfig;
  loopOptions: AgentLoopOptions;
  hookEngine: HookEngine | null;
  hookState: HookSessionState | null;
  getSnapshot: () => RequestSnapshot | null;
  getParentCancel: () => CancelToken | null;
  parentPermissionMode: (sessionId: string) => PermissionMode;
  onBackgroundFinished: (parentSessionId: string) => void;
  foregroundLimitMs?: number;
  worktrees?: WorktreeService;
}

export interface StartSubAgentInput {
  kind: AgentKind;
  task: string;
  roleName?: string;
  background: boolean;
  notify: SubAgentNotify;
  parentSessionId: string;
  log?: (line: string) => void;
}

interface ChildControl {
  parentSessionId: string;
  background: boolean;
  detach: () => void;
  drop: () => void;
}

const controls = new Map<string, ChildControl>();

export function hasForegroundAgent(parentSessionId: string): boolean {
  for (const control of controls.values()) {
    if (control.parentSessionId === parentSessionId && !control.background) {
      return true;
    }
  }
  return false;
}

/** 把当前前台子任务转入后台。没有前台任务时什么也不做。 */
export function detachForeground(parentSessionId: string): void {
  for (const control of controls.values()) {
    if (control.parentSessionId === parentSessionId && !control.background) {
      control.detach();
    }
  }
}

/** 停掉该父会话名下仍在跑的子任务，包括已经转入后台的。 */
export function stopParentAgents(parentSessionId: string): void {
  for (const control of controls.values()) {
    if (control.parentSessionId === parentSessionId) control.drop();
  }
}

/**
 * 启动子任务。启动前的失败不建任务。
 * 前台会等到子任务停止调用工具，或转入后台。后台立刻返回任务编号。
 */
export async function startSubAgent(
  deps: SubAgentDeps,
  input: StartSubAgentInput,
): Promise<ToolResult> {
  const taskText = input.task.trim();
  if (!taskText) {
    return fail("任务说明不能为空");
  }

  const runsInBackground = input.kind === "fork" || input.background;
  if (!runsInBackground && hasForegroundAgent(input.parentSessionId)) {
    return fail("已有前台子任务在运行");
  }

  let role: AgentRecord | undefined;
  if (input.kind === "defined") {
    const name = input.roleName?.trim().toLowerCase() ?? "";
    if (!name) return fail("找不到角色");
    role = deps.catalog.get(name);
    if (!role) return fail(`找不到角色：${name}`);
    if (role.model && !deps.providers.some((item) => item.model === role!.model)) {
      return fail(`找不到模型：${role.model}`);
    }
  }

  const snapshot = input.kind === "fork" ? deps.getSnapshot() : null;
  if (input.kind === "fork" && !snapshot) {
    return fail("没有可继承的对话快照");
  }

  let worktreeName: string | undefined;
  let worktreePath: string | undefined;
  if (input.kind === "defined" && role?.isolation === "worktree") {
    if (!deps.worktrees) {
      return fail("工作目录隔离服务未就绪");
    }
    try {
      worktreeName = generateAgentWorktreeName(role.name);
      await deps.worktrees.create(worktreeName);
      const info = deps.worktrees.enter(worktreeName);
      worktreePath = info.path;
    } catch (err) {
      if (worktreeName && deps.worktrees) {
        try {
          deps.worktrees.exit(worktreeName);
          await deps.worktrees.remove(worktreeName);
        } catch {
          // 启动失败时尽量清掉半成品
        }
      }
      return fail(
        `无法建立隔离工作目录：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const allTools = deps.registry.toDefinitions();
  const tools = visibleTools({
    kind: input.kind,
    all: allTools,
    ...(role ? { role } : {}),
    ...(snapshot ? { snapshot } : {}),
  });
  const allowNames = new Set(tools.map((tool) => tool.name));
  const policy = {
    allowNames,
    interactive: !runsInBackground,
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mew-agent-"));
  const store = new SessionStore(dir);
  const child = store.create("子任务");
  const mode =
    role?.permission ?? deps.parentPermissionMode(input.parentSessionId);
  deps.permissionModes.set(child.id, mode);

  if (snapshot) {
    for (const message of snapshot.messages) {
      store.appendMessage(child.id, copyMessage(message));
    }
  }

  const childRoot = worktreePath ?? deps.workspaceRoot;
  const task = deps.board.create({
    parentSessionId: input.parentSessionId,
    childSessionId: child.id,
    kind: input.kind,
    ...(role ? { roleName: role.name } : {}),
    background: runsInBackground,
    notify: input.notify,
    ...(worktreeName ? { worktreeName } : {}),
    ...(worktreePath ? { worktreePath } : {}),
  });

  const childCancel = createCancelToken();
  let linked = !runsInBackground;
  let dropped = false;
  let phase: "foreground" | "background" | "done" = runsInBackground
    ? "background"
    : "foreground";
  let resolveForeground: ((result: ToolResult) => void) | null = null;

  const detach = () => {
    if (phase !== "foreground") return;
    phase = "background";
    linked = false;
    policy.interactive = false;
    deps.board.markBackground(task.id);
    const control = controls.get(task.id);
    if (control) control.background = true;
    deps.gate.setAskObserver(null);
    resolveForeground?.({
      ok: true,
      content: backgroundText(task.id),
    });
    resolveForeground = null;
  };

  const drop = () => {
    dropped = true;
    linked = false;
    childCancel.cancel();
  };

  controls.set(task.id, {
    parentSessionId: input.parentSessionId,
    background: runsInBackground,
    detach,
    drop,
  });

  if (runsInBackground) {
    void runChild();
    return { ok: true, content: backgroundText(task.id) };
  }
  return new Promise((resolve) => {
    resolveForeground = resolve;
    void runChild();
  });

  async function runChild(): Promise<void> {
    const limit = deps.foregroundLimitMs ?? FOREGROUND_LIMIT_MS;
    let acc = 0;
    let mark = Date.now();
    let paused = false;
    const timer = setInterval(() => {
      if (phase !== "foreground" || paused) {
        mark = Date.now();
        return;
      }
      const now = Date.now();
      const delta = now - mark;
      mark = now;
      if (delta <= 0) return;
      acc += delta;
      deps.board.addRunningMs(task.id, delta);
      if (acc >= limit) detach();
    }, 100);
    const watch = setInterval(() => {
      if (!linked) return;
      if (deps.getParentCancel()?.isCancelled) childCancel.cancel();
    }, 50);

    if (!runsInBackground) {
      deps.gate.setAskObserver({
        onStart() {
          const now = Date.now();
          if (!paused && phase === "foreground") {
            const delta = now - mark;
            if (delta > 0) {
              acc += delta;
              deps.board.addRunningMs(task.id, delta);
            }
          }
          paused = true;
          mark = now;
        },
        onEnd() {
          paused = false;
          mark = Date.now();
        },
      });
    }

    let stoppedReason = "error";
    let stoppedMessage = "子任务失败";
    let messages: ChatMessage[] = [];
    try {
      const resolved = resolveProvider(deps, role);
      const pipeline = new ContextPipeline(
        store,
        resolved.provider,
        resolved.config,
      );
      if (deps.hookEngine) {
        const engine = deps.hookEngine;
        store.setOnMessage((id, message) => {
          const event =
            message.role === "user"
              ? "user_message"
              : message.role === "assistant"
                ? "assistant_message"
                : null;
          if (!event) return;
          void engine.dispatch({ event, sessionId: id }).catch((err) => {
            console.error(
              `[hook] 消息事件失败：${err instanceof Error ? err.message : String(err)}`,
            );
          });
        });
        pipeline.setOnCompact(async (id) => {
          await engine.dispatch({ event: "compact", sessionId: id });
        });
      }
      const loop = new AgentLoop(
        store,
        resolved.provider,
        resolved.config,
        deps.registry,
        childRoot,
        deps.gate,
        deps.loopOptions,
        pipeline,
      );
      if (deps.hookEngine && deps.hookState) {
        loop.setHooks(deps.hookEngine, deps.hookState);
      }
      let system =
        input.kind === "fork" ? (snapshot?.system ?? "") : (role?.body ?? "");
      if (worktreePath && input.kind === "defined") {
        system = `${system}\n\n你当前在独立 Git 工作目录中工作。所有文件与命令操作都相对于该目录，不要假设主仓库工作区：\n${worktreePath}`;
      }
      for await (const event of loop.run(child.id, taskText, {
        cancel: childCancel,
        mode: "execute",
        systemOverride: system,
        toolsOverride: tools,
        literalMessages: true,
        recordSnapshot: false,
        maxIterations: role?.maxTurns ?? deps.loopOptions.maxIterations,
        skipMemoryUpdate: true,
        skipContextUsage: true,
        toolPolicy: policy,
        onUsage: (inputTokens, outputTokens) => {
          deps.board.addUsage(task.id, inputTokens, outputTokens);
        },
      })) {
        if (event.type === "agent_stopped") {
          stoppedReason = event.reason;
          stoppedMessage = event.message;
        }
      }
      messages = store.get(child.id)?.messages ?? [];
    } catch (err) {
      stoppedReason = "error";
      stoppedMessage = err instanceof Error ? err.message : String(err);
    } finally {
      clearInterval(timer);
      clearInterval(watch);
      deps.gate.setAskObserver(null);
      deps.hookState?.clear(child.id);
      fs.rmSync(dir, { recursive: true, force: true });
      controls.delete(task.id);
      await releaseWorktree(deps, task);
    }

    if (dropped || deps.board.get(task.id)?.status === "cancelled") {
      if (deps.board.get(task.id)?.status === "running") {
        deps.board.finish(task.id, "cancelled", "子任务已取消");
      }
      if (phase === "foreground") {
        phase = "done";
        resolveForeground?.(fail("子任务已取消"));
        resolveForeground = null;
      }
      return;
    }

    const built = buildFinal(stoppedReason, stoppedMessage, messages);
    const wasForeground = phase === "foreground";
    phase = "done";
    deps.board.finish(task.id, built.status, built.text);
    const latest = deps.board.get(task.id);
    if (wasForeground) {
      resolveForeground?.(
        built.status === "completed"
          ? { ok: true, content: built.text }
          : fail(built.text),
      );
      resolveForeground = null;
      return;
    }
    if (!latest || latest.notify === "log") {
      input.log?.(`[hook] 子任务 ${task.id}：${built.text}`);
      return;
    }
    deps.board.enqueue(input.parentSessionId, deliveryText(latest));
    deps.onBackgroundFinished(input.parentSessionId);
  }
}

async function releaseWorktree(
  deps: SubAgentDeps,
  task: SubAgentTask,
): Promise<void> {
  const name = task.worktreeName;
  if (!name || !deps.worktrees) return;
  try {
    deps.worktrees.exit(name);
    const dirty = await deps.worktrees.isDirty(name);
    if (dirty.blocked) return;
    await deps.worktrees.remove(name);
  } catch (err) {
    console.error(
      `[worktree] 子任务结束后清理失败 ${name}：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function resolveProvider(
  deps: SubAgentDeps,
  role: AgentRecord | undefined,
): { provider: ChatProvider; config: ProviderConfig } {
  if (!role?.model) {
    return { provider: deps.parentProvider, config: deps.parentConfig };
  }
  const found = deps.providers.find((item) => item.model === role.model);
  if (!found || found.model === deps.parentConfig.model) {
    return { provider: deps.parentProvider, config: deps.parentConfig };
  }
  return { provider: createProvider(found), config: found };
}

function buildFinal(
  reason: string,
  message: string,
  messages: ChatMessage[],
): { status: Exclude<SubAgentStatus, "running">; text: string } {
  const assistants = messages
    .filter((item) => item.role === "assistant" && item.content.trim())
    .map((item) => item.content.trim());
  const last = assistants.at(-1) ?? "";
  const all = assistants.join("\n");
  if (reason === "cancelled") {
    return {
      status: "cancelled",
      text: all || "子任务已取消，没有留下文字",
    };
  }
  if (reason === "completed") {
    return {
      status: "completed",
      text: last || "子任务结束，没有留下文字",
    };
  }
  return {
    status: "failed",
    text: all ? `${message}\n${all}` : `${message}\n子任务结束，没有留下文字`,
  };
}

function deliveryText(task: SubAgentTask): string {
  return [
    `子任务 ${task.id} 已结束。`,
    task.finalText ?? "",
    `用量：输入 ${task.usage.inputTokens}，输出 ${task.usage.outputTokens}`,
  ].join("\n");
}

function backgroundText(id: string): string {
  return `已转入后台。任务 ${id}`;
}

function copyMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    ...(message.toolCalls
      ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) }
      : {}),
  };
}

function fail(content: string): ToolResult {
  return { ok: false, content, errorCode: "subagent" };
}
