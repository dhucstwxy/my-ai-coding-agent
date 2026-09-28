import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderConfig } from "../config/types.js";
import { createProvider } from "../provider/factory.js";
import type { ChatProvider } from "../provider/types.js";
import { SessionStore } from "../session/store.js";
import type { ChatMessage } from "../session/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  AgentLoop,
  type AgentPromptContext,
  type SkillTurnContext,
} from "../agent/loop.js";
import { createCancelToken, type CancelToken } from "../agent/cancel.js";
import { PlanModeStore } from "../agent/plan-mode.js";
import type {
  AgentEvent,
  AgentLoopOptions,
  AgentMode,
  TokenUsageInfo,
} from "../agent/types.js";
import { DEFAULT_AGENT_OPTIONS } from "../agent/types.js";
import type { PermissionGate } from "../permission/gate.js";
import type { PermissionModeStore } from "../permission/mode-store.js";
import type { PermissionMode, PermissionPrompter } from "../permission/types.js";
import {
  ContextPipeline,
  DEFAULT_CONTEXT_WINDOW,
} from "../context/index.js";
import {
  type CommandContext,
  type CommandRegistry,
  type MemoryScopeInfo,
  type StatusSnapshot,
  type UiPort,
  dispatch,
} from "../commands/index.js";
import type { HookEngine } from "../hooks/engine.js";
import type { HookSessionState } from "../hooks/state.js";
import { memoryIndexPath } from "../memory/paths.js";
import {
  runSkill,
  SkillFatalError,
  visibleToolNames,
  type SkillCatalog,
  type SkillCommandBridge,
  type SkillCommandSync,
  type SkillRecord,
  type SkillRun,
  type SkillRunDeps,
  type SkillSession,
} from "../skills/index.js";
import {
  AgentFatalError,
  startSubAgent,
  stopParentAgents,
  detachForeground,
  hasForegroundAgent,
  type AgentCatalog,
  type AgentToolInput,
  type SubAgentDeps,
  type SubAgentTask,
} from "../agents/index.js";
import type { TaskBoard } from "../agents/board.js";
import type { ToolContext, ToolResult } from "../tools/types.js";

export interface HookHost {
  engine: HookEngine;
  state: HookSessionState;
}

export interface AgentHost {
  catalog: AgentCatalog;
  board: TaskBoard;
  providers: ProviderConfig[];
  /** 测试可缩短前台时限。正式运行为 60 秒 */
  foregroundLimitMs?: number;
}

export interface SkillHost {
  catalog: SkillCatalog;
  session: SkillSession;
  providers: ProviderConfig[];
  sync: SkillCommandSync;
  bridge: SkillCommandBridge;
  runDeps: SkillRunDeps;
}

/**
 * 对话门面：命令分发 + Agent Loop + 取消令牌。
 */
export class ChatService {
  private readonly planModes = new PlanModeStore();
  private readonly loop: AgentLoop;
  private readonly pipeline: ContextPipeline;
  private readonly workspaceRoot: string;
  private readonly provider: ChatProvider;
  private readonly toolRegistry: ToolRegistry;
  private readonly loopOptions: AgentLoopOptions;
  private readonly promptContext: AgentPromptContext;
  private currentCancel: CancelToken | null = null;
  private emitCurrent: ((event: AgentEvent) => void) | null = null;
  private warningKey = "";
  private readonly lastTokenUsage = new Map<string, TokenUsageInfo>();
  private hookEngine: HookEngine | null = null;
  private hookState: HookSessionState | null = null;
  private agents: AgentHost | null = null;
  private loopDepth = 0;
  private delivering = false;
  private agentWarningKey = "";
  private idleDelivery: ((sessionId: string) => void) | null = null;

  constructor(
    private readonly store: SessionStore,
    provider: ChatProvider,
    private readonly providerConfig: ProviderConfig,
    registry: ToolRegistry,
    workspaceRoot: string,
    private readonly gate: PermissionGate,
    private readonly permissionModes: PermissionModeStore,
    private readonly commands: CommandRegistry,
    options: AgentLoopOptions = DEFAULT_AGENT_OPTIONS,
    promptContext: AgentPromptContext = {},
    private readonly skills?: SkillHost,
    hooks?: HookHost,
    agents?: AgentHost,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.provider = provider;
    this.toolRegistry = registry;
    this.loopOptions = options;
    this.promptContext = promptContext;
    this.pipeline = new ContextPipeline(store, provider, providerConfig);
    this.loop = new AgentLoop(
      store,
      provider,
      providerConfig,
      registry,
      workspaceRoot,
      gate,
      options,
      this.pipeline,
      promptContext,
    );
    if (skills) {
      this.loop.setSkillContext(this.createSkillTurn());
      this.bindSkillRun(skills);
    }
    if (hooks) {
      this.hookEngine = hooks.engine;
      this.hookState = hooks.state;
      this.loop.setHooks(hooks.engine, hooks.state);
      this.pipeline.setOnCompact(async (id) => {
        await hooks.engine.dispatch({ event: "compact", sessionId: id });
      });
      store.setOnMessage((id, message) => {
        const event =
          message.role === "user"
            ? "user_message"
            : message.role === "assistant"
              ? "assistant_message"
              : null;
        if (!event) return;
        void hooks.engine.dispatch({ event, sessionId: id }).catch((err) => {
          console.error(
            `[hook] 消息事件失败：${err instanceof Error ? err.message : String(err)}`,
          );
        });
      });
    }
    if (agents) {
      this.agents = agents;
      this.loop.setAgentCatalog(() => this.agents?.catalog.catalogText() ?? "");
    }
  }

  getCommandRegistry(): CommandRegistry {
    return this.commands;
  }

  /** 取消当前正在进行的 Agent 循环 */
  cancelCurrent(): void {
    this.currentCancel?.cancel();
  }

  getMode(sessionId: string) {
    return this.planModes.getMode(sessionId);
  }

  getPermissionMode(sessionId: string): PermissionMode {
    return this.permissionModes.get(sessionId);
  }

  /** TUI 挂载后换成真正的确认器。未绑定前闸门会拒绝询问。 */
  attachPrompter(prompter: PermissionPrompter): void {
    this.gate.setPrompter(prompter);
  }

  /**
   * 直接跑 Agent，不再二次命令解析。
   * 供 UiPort.submitToAgent 使用。
   */
  async *runAgent(
    sessionId: string,
    userText: string,
  ): AsyncIterable<AgentEvent> {
    yield* this.runLoop(sessionId, userText);
  }

  async *send(
    sessionId: string,
    userText: string,
  ): AsyncIterable<AgentEvent> {
    const channel = createEventChannel();
    const ui = this.createUiPort(sessionId, channel.push);
    const ctx = this.createCommandContext(sessionId, ui, channel.push);

    const work = (async () => {
      try {
        this.emitCurrent = channel.push;
        this.refreshSkills(channel.push);
        const result = await dispatch(userText, ctx, this.commands);
        if (!result.handled) {
          for await (const e of this.runLoop(sessionId, result.text)) {
            channel.push(e);
          }
          return;
        }
        if (result.unknown) {
          channel.push({
            type: "ui_message",
            text: `未知命令 /${result.name}。输入 /help 查看可用命令。`,
          });
          channel.push({
            type: "agent_stopped",
            reason: "completed",
            message: "未知命令",
          });
          channel.push({ type: "done" });
          return;
        }
        // handler 已执行；若未发出 done（纯本地切换等），补一个收尾
        if (!channel.sawDone) {
          channel.push({
            type: "agent_stopped",
            reason: "completed",
            message: "命令完成",
          });
          channel.push({ type: "done" });
        }
      } catch (err) {
        channel.push({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        channel.push({ type: "done" });
      } finally {
        this.emitCurrent = null;
        channel.close();
      }
    })();

    yield* channel;
    await work;
  }

  private createUiPort(
    sessionId: string,
    emit: (e: AgentEvent) => void,
  ): UiPort {
    return {
      showMessage: (text) => {
        emit({ type: "ui_message", text });
      },
      clearScreen: () => {
        emit({ type: "ui_clear" });
      },
      submitToAgent: async (text) => {
        for await (const e of this.runLoop(sessionId, text)) {
          emit(e);
        }
      },
      setAgentMode: (mode: AgentMode) => {
        this.planModes.setMode(sessionId, mode);
        emit({ type: "mode_changed", mode });
      },
      setPermissionMode: (mode: PermissionMode) => {
        this.permissionModes.set(sessionId, mode);
        emit({ type: "permission_mode_changed", mode });
      },
      getStatusSnapshot: () => this.buildStatusSnapshot(sessionId),
    };
  }

  private createCommandContext(
    sessionId: string,
    ui: UiPort,
    emit: (e: AgentEvent) => void,
  ): CommandContext {
    return {
      sessionId,
      workspaceRoot: this.workspaceRoot,
      ui,
      runCompact: async (note) => {
        for await (const e of this.runCompact(sessionId, note)) {
          emit(e);
        }
      },
      getSessionInfo: () => {
        const session = this.store.get(sessionId);
        if (!session) return null;
        return {
          id: session.id,
          title: session.title,
          messageCount: session.messages.length,
          path: this.store.pathFor(sessionId),
        };
      },
      getMemoryInfo: () => readMemoryInfo(this.workspaceRoot),
      clearActivatedSkills: () => {
        this.skills?.session.clear(sessionId);
      },
    };
  }

  private refreshSkills(emit: (event: AgentEvent) => void): void {
    if (!this.skills) return;
    try {
      const names = new Set(this.toolRegistry.list().map((tool) => tool.name));
      this.skills.catalog.refresh(names);
    } catch (err) {
      if (err instanceof SkillFatalError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
    this.skills.sync.sync(this.commands);
    const key = this.skills.catalog
      .warnings()
      .map((warning) => `${warning.path}:${warning.reason}`)
      .join("\n");
    if (key && key !== this.warningKey) {
      this.warningKey = key;
      emit({
        type: "ui_message",
        text: this.skills.catalog
          .warnings()
          .map((warning) => `${warning.path}：${warning.reason}`)
          .join("\n"),
      });
    }
  }

  private bindSkillRun(skills: SkillHost): void {
    const deps = skills.runDeps;
    deps.session = skills.session;
    deps.findModel = (model) =>
      skills.providers.some((provider) => provider.model === model);
    deps.recentMessages = (sessionId, count) => {
      if (count <= 0) return [];
      const messages = this.store.get(sessionId)?.messages ?? [];
      return messages.slice(-count);
    };
    deps.appendSummary = (sessionId, text) => {
      this.store.appendMessage(sessionId, {
        id: randomUUID(),
        role: "assistant",
        content: text,
        createdAt: new Date().toISOString(),
      });
    };
    deps.submitToAgent = async (sessionId, task) => {
      const emit = this.emitCurrent;
      if (!emit) return;
      for await (const event of this.runLoop(sessionId, task)) {
        emit(event);
      }
    };
    deps.runIsolated = (input) => this.runIsolated(input);
    skills.bridge.runSkill = (run) => runSkill(run, deps);
  }

  private createSkillTurn(): SkillTurnContext {
    const skills = this.skills!;
    return {
      pinnedText: (sessionId) =>
        skills.session.pinnedText(sessionId, skills.catalog),
      catalogText: () => skills.catalog.catalogText(),
      visibleNames: (sessionId, mode) =>
        visibleToolNames({
          allNames: this.toolRegistry.list().map((tool) => tool.name),
          planMode: mode,
          active: skills.session.recordsFor(sessionId, skills.catalog),
        }),
      resolveModel: (sessionId) => {
        const name = skills.session.modelFor(sessionId, skills.catalog);
        if (!name) {
          return { provider: this.provider, config: this.providerConfig };
        }
        const found = skills.providers.find((item) => item.model === name);
        if (!found) return { error: `找不到模型：${name}` };
        if (
          found.name === this.providerConfig.name &&
          found.model === this.providerConfig.model
        ) {
          return { provider: this.provider, config: this.providerConfig };
        }
        return { provider: createProvider(found), config: found };
      },
    };
  }

  private async runIsolated(input: {
    sessionId: string;
    skill: SkillRecord;
    task: string;
    history: ChatMessage[];
  }): Promise<string> {
    const skills = this.skills;
    const wanted = skills?.session.modelFor(input.sessionId, skills.catalog);
    const found = wanted
      ? skills?.providers.find((item) => item.model === wanted)
      : undefined;
    const config = found ?? this.providerConfig;
    const provider =
      config === this.providerConfig
        ? this.provider
        : createProvider(config);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mew-skill-run-"));
    const temp = new SessionStore(dir);
    const created = temp.create();
    for (const message of input.history) {
      temp.appendMessage(created.id, { ...message, id: randomUUID() });
    }
    const loop = new AgentLoop(
      temp,
      provider,
      config,
      this.toolRegistry,
      this.workspaceRoot,
      this.gate,
      this.loopOptions,
      undefined,
      this.promptContext,
    );
    if (skills) loop.setSkillContext(this.createSkillTurn());
    if (this.hookEngine && this.hookState) {
      loop.setHooks(this.hookEngine, this.hookState);
    }
    const cancel = createCancelToken();
    const emit = this.emitCurrent;
    for await (const event of loop.run(created.id, input.task, {
      cancel,
      mode: this.planModes.getMode(input.sessionId),
      skillSessionId: input.sessionId,
    })) {
      if (event.type === "done") continue;
      emit?.(event);
    }
    const messages = temp.get(created.id)?.messages ?? [];
    const last = [...messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.content.trim());
    return last?.content.trim() ?? "";
  }

  private buildStatusSnapshot(sessionId: string): StatusSnapshot {
    const session = this.store.get(sessionId);
    return {
      agentMode: this.planModes.getMode(sessionId),
      permissionMode: this.permissionModes.get(sessionId),
      sessionId,
      sessionTitle: session?.title ?? "（无）",
      messageCount: session?.messages.length ?? 0,
      sessionPath: this.store.pathFor(sessionId),
      tokenUsage: this.lastTokenUsage.get(sessionId),
      compactCircuitOpen: this.pipeline.isCompactCircuitOpen(sessionId),
    };
  }

  private async *runCompact(
    sessionId: string,
    userNote: string,
  ): AsyncIterable<AgentEvent> {
    const session = this.store.get(sessionId);
    if (!session) {
      yield { type: "error", message: `会话不存在：${sessionId}` };
      yield { type: "done" };
      return;
    }

    const buffered: AgentEvent[] = [];
    let result;
    try {
      result = await this.pipeline.run({
        sessionId,
        messages: session.messages,
        contextWindow:
          this.providerConfig.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        mode: "manual",
        force: true,
        userNote: userNote || undefined,
        onEvent: (e) => buffered.push(e),
      });
    } catch (err) {
      yield {
        type: "error",
        message: `手动压缩失败：${err instanceof Error ? err.message : String(err)}`,
      };
      yield { type: "done" };
      return;
    }

    for (const e of buffered) {
      yield e;
    }

    if (result.micro.changed) {
      yield {
        type: "text_delta",
        text: `轻量预防：已将 ${result.micro.spilledCount} 个过大的工具结果存盘。\n`,
      };
    }

    if (result.auto?.attempted && result.auto.succeeded) {
      yield {
        type: "text_delta",
        text: "重量压缩成功：较早消息已替换为结构化摘要。\n",
      };
    } else if (
      result.auto?.attempted &&
      !result.auto.succeeded &&
      result.auto.error?.includes("无需压缩")
    ) {
      yield {
        type: "text_delta",
        text: "当前没有可摘要的较早消息，未改写会话。\n",
      };
    } else if (result.auto?.attempted && !result.auto.succeeded) {
      yield {
        type: "text_delta",
        text: `重量压缩失败：${result.auto.error ?? "未知错误"}\n`,
      };
    } else {
      yield {
        type: "text_delta",
        text: "未执行重量压缩。\n",
      };
    }

    yield {
      type: "agent_stopped",
      reason: "completed",
      message: "手动压缩结束",
    };
    yield { type: "done" };
  }

  listSubAgents(sessionId: string): SubAgentTask[] {
    return this.agents?.board.listRunning(sessionId) ?? [];
  }

  hasForegroundSubAgent(sessionId: string): boolean {
    return hasForegroundAgent(sessionId);
  }

  detachForegroundSubAgent(sessionId: string): void {
    detachForeground(sessionId);
  }

  /** 离开会话或进程退出：停掉名下子任务并丢掉待送回结果。 */
  stopSubAgents(sessionId: string): void {
    stopParentAgents(sessionId);
    this.agents?.board.clearParent(sessionId);
  }

  setIdleDeliveryHandler(handler: ((sessionId: string) => void) | null): void {
    this.idleDelivery = handler;
  }

  /** 父循环空闲时，把已经写好的结果接着跑一轮。 */
  async *followUp(sessionId: string): AsyncIterable<AgentEvent> {
    yield* this.drainDeliveries(sessionId);
  }

  /** 委派工具入口。启动前失败不建任务。 */
  startAgent(input: AgentToolInput, ctx: ToolContext): Promise<ToolResult> {
    if (!this.agents) {
      return Promise.resolve({
        ok: false,
        content: "子任务尚未就绪",
        errorCode: "subagent",
      });
    }
    if (!ctx.sessionId) {
      return Promise.resolve({
        ok: false,
        content: "当前没有会话，无法派生子任务",
        errorCode: "invalid_args",
      });
    }
    return startSubAgent(this.subAgentDeps(), {
      kind: input.type,
      task: input.task,
      ...(input.name ? { roleName: input.name } : {}),
      background: input.background ?? false,
      notify: "parent",
      parentSessionId: ctx.sessionId,
    });
  }

  /**
   * Hook 的 subagent 动作。只启动定义式并转入后台，最终答复只记日志。
   * 调用方要先确认这不是子会话。
   */
  async startHookAgent(
    sessionId: string,
    name: string,
    log: (line: string) => void,
  ): Promise<void> {
    if (!this.agents) {
      log(`[hook] 子代理尚未实现：${name}`);
      return;
    }
    this.refreshAgents();
    const role = this.agents.catalog.get(name);
    if (!role) {
      log(`[hook] 找不到角色：${name}`);
      return;
    }
    const result = await startSubAgent(this.subAgentDeps(), {
      kind: "defined",
      task: role.description?.trim() || "请遵循系统提示完成任务。",
      roleName: role.name,
      background: true,
      notify: "log",
      parentSessionId: sessionId,
      log,
    });
    if (!result.ok) log(`[hook] ${result.content}`);
  }

  private subAgentDeps(): SubAgentDeps {
    const agents = this.agents;
    if (!agents) {
      throw new Error("子任务尚未就绪");
    }
    return {
      workspaceRoot: this.workspaceRoot,
      catalog: agents.catalog,
      board: agents.board,
      registry: this.toolRegistry,
      gate: this.gate,
      permissionModes: this.permissionModes,
      providers: agents.providers,
      parentProvider: this.provider,
      parentConfig: this.providerConfig,
      loopOptions: this.loopOptions,
      hookEngine: this.hookEngine,
      hookState: this.hookState,
      getSnapshot: () => this.loop.getRequestSnapshot(),
      getParentCancel: () => this.currentCancel,
      parentPermissionMode: (sessionId) => this.permissionModes.get(sessionId),
      onBackgroundFinished: (parentSessionId) => {
        if (this.loopDepth === 0 && !this.delivering) {
          this.idleDelivery?.(parentSessionId);
        }
      },
      ...(agents.foregroundLimitMs !== undefined
        ? { foregroundLimitMs: agents.foregroundLimitMs }
        : {}),
    };
  }

  /** 进入主循环前重新读取角色。同层重名或未知工具会退出进程。 */
  private refreshAgents(): string {
    if (!this.agents) return "";
    try {
      this.agents.catalog.refresh(
        new Set(this.toolRegistry.list().map((tool) => tool.name)),
      );
    } catch (err) {
      if (err instanceof AgentFatalError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
    const text = this.agents.catalog
      .warnings()
      .map((warning) => `${warning.path}：${warning.reason}`)
      .join("\n");
    if (!text || text === this.agentWarningKey) return "";
    this.agentWarningKey = text;
    return text;
  }

  private async *runLoop(
    sessionId: string,
    userText: string,
  ): AsyncIterable<AgentEvent> {
    const warning = this.refreshAgents();
    if (warning) yield { type: "ui_message", text: warning };
    const cancel = createCancelToken();
    this.currentCancel = cancel;
    const mode = this.planModes.getMode(sessionId);
    this.loopDepth += 1;
    try {
      for await (const event of this.loop.run(sessionId, userText, {
        cancel,
        mode,
      })) {
        this.noteUsage(sessionId, event);
        yield event;
      }
    } finally {
      this.loopDepth -= 1;
      if (this.currentCancel === cancel) {
        this.currentCancel = null;
      }
    }
    yield* this.drainDeliveries(sessionId);
  }

  private noteUsage(sessionId: string, event: AgentEvent): void {
    if (event.type !== "token_usage") return;
    this.lastTokenUsage.set(sessionId, {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheHitTokens: event.cacheHitTokens,
      cacheMissTokens: event.cacheMissTokens,
      cacheAvailable: event.cacheAvailable,
    });
  }

  /**
   * 把待送回的正文各写一条用户消息，再续跑一轮，不再写第二遍。
   * 这一轮里新到的结果留到本轮结束后再送。
   */
  private async *drainDeliveries(sessionId: string): AsyncIterable<AgentEvent> {
    if (!this.agents || this.delivering) return;
    const texts = this.agents.board.drain(sessionId);
    if (texts.length === 0) return;
    this.delivering = true;
    this.loopDepth += 1;
    const cancel = createCancelToken();
    this.currentCancel = cancel;
    try {
      for (const text of texts) {
        this.store.appendMessage(sessionId, {
          id: randomUUID(),
          role: "user",
          content: text,
          createdAt: new Date().toISOString(),
        });
      }
      for await (const event of this.loop.run(sessionId, "", {
        cancel,
        mode: this.planModes.getMode(sessionId),
        skipUserAppend: true,
      })) {
        this.noteUsage(sessionId, event);
        yield event;
      }
    } finally {
      this.loopDepth -= 1;
      this.delivering = false;
      if (this.currentCancel === cancel) {
        this.currentCancel = null;
      }
    }
    yield* this.drainDeliveries(sessionId);
  }
}

function readMemoryInfo(workspaceRoot: string): MemoryScopeInfo[] {
  const scopes: Array<"project" | "user"> = ["project", "user"];
  return scopes.map((scope) => {
    const filePath = memoryIndexPath(scope, workspaceRoot);
    try {
      if (!fs.existsSync(filePath)) {
        return { scope, path: filePath, exists: false };
      }
      const content = fs.readFileSync(filePath, "utf8");
      const stat = fs.statSync(filePath);
      const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;
      return {
        scope,
        path: filePath,
        exists: true,
        lineCount,
        byteSize: stat.size,
      };
    } catch {
      return { scope, path: filePath, exists: false };
    }
  });
}

/** 异步事件通道：handler 里 emit，send 侧边收边 yield */
function createEventChannel(): {
  push: (e: AgentEvent) => void;
  close: () => void;
  sawDone: boolean;
  [Symbol.asyncIterator](): AsyncIterator<AgentEvent>;
} {
  const queue: AgentEvent[] = [];
  let closed = false;
  let sawDone = false;
  let wake: (() => void) | null = null;

  const notify = () => {
    wake?.();
    wake = null;
  };

  return {
    get sawDone() {
      return sawDone;
    },
    push(e) {
      if (e.type === "done") sawDone = true;
      queue.push(e);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
