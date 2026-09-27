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

  private async *runLoop(
    sessionId: string,
    userText: string,
  ): AsyncIterable<AgentEvent> {
    const cancel = createCancelToken();
    this.currentCancel = cancel;
    const mode = this.planModes.getMode(sessionId);
    try {
      for await (const event of this.loop.run(sessionId, userText, {
        cancel,
        mode,
      })) {
        if (event.type === "token_usage") {
          this.lastTokenUsage.set(sessionId, {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheHitTokens: event.cacheHitTokens,
            cacheMissTokens: event.cacheMissTokens,
            cacheAvailable: event.cacheAvailable,
          });
        }
        yield event;
      }
    } finally {
      if (this.currentCancel === cancel) {
        this.currentCancel = null;
      }
    }
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
