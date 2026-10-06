import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { CancelToken } from "../agent/cancel.js";
import type { ChatService } from "../chat/service.js";
import { complete } from "../commands/complete.js";
import type {
  PermissionChoice,
  PermissionMode,
  PermissionPrompt,
  PermissionPrompter,
} from "../permission/types.js";
import type { AgentEvent, AgentMode } from "../agent/types.js";
import type { SessionStore } from "../session/store.js";
import type { ChatMessage } from "../session/types.js";
import { MessageList } from "./message-list.js";

export interface ChatScreenProps {
  sessionId: string;
  store: SessionStore;
  chat: ChatService;
  warnings: string[];
  onBack: () => void;
  /** 进入时 session_start，卸载（含返回会话列表）时 session_end 并清空注入 */
  sessionHooks?: {
    enter(sessionId: string): Promise<void>;
    leave(sessionId: string): Promise<void>;
  };
}

export interface PromptSession {
  prompter: PermissionPrompter;
  isWaiting: () => boolean;
  choose: (choice: PermissionChoice) => void;
}

/**
 * 询问发生在 for-await 暂停期间，由这里直接改界面状态，而不是等事件流。
 */
export function createPromptSession(
  onChange: (prompt: PermissionPrompt | null) => void,
): PromptSession {
  let pending: ((choice: PermissionChoice) => void) | null = null;

  return {
    isWaiting: () => pending !== null,
    choose(choice) {
      const resolve = pending;
      if (!resolve) return;
      resolve(choice);
    },
    prompter: {
      ask(prompt: PermissionPrompt, signal: CancelToken) {
        if (signal.isCancelled) return Promise.resolve("deny");
        onChange(prompt);
        return new Promise((resolve) => {
          pending = (choice) => {
            pending = null;
            onChange(null);
            resolve(choice);
          };
        });
      },
    },
  };
}

function agentMark(mode: AgentMode): string {
  return mode === "plan" ? "PLAN" : "DEFAULT";
}

function permMark(mode: PermissionMode): string {
  if (mode === "strict") return "STRICT";
  if (mode === "allow") return "ALLOW";
  return "DEFAULT";
}

/** 前台子任务按 b 转入后台。确认框打开、或当前没有前台子任务时，b 不做这件事。 */
export function foregroundDetachKey(input: {
  promptOpen: boolean;
  busy: boolean;
  char: string;
  ctrl: boolean;
  meta: boolean;
  hasForeground: boolean;
}): boolean {
  if (input.promptOpen) return false;
  return (
    input.busy &&
    input.char === "b" &&
    !input.ctrl &&
    !input.meta &&
    input.hasForeground
  );
}

export function ChatScreen({
  sessionId,
  store,
  chat,
  warnings,
  onBack,
  sessionHooks,
}: ChatScreenProps) {
  useEffect(() => {
    void sessionHooks?.enter(sessionId);
    return () => {
      chat.stopSubAgents(sessionId);
      void sessionHooks?.leave(sessionId);
    };
  }, [sessionHooks, sessionId, chat]);
  // 只在挂载时 open 一次。每次渲染都 open 会在「assistant 已写入、tool 结果未齐」时
  // 把未配对尾部截掉并 rewriteAll，会话会被清空到只剩 user。
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => store.open(sessionId)?.messages ?? [],
  );
  const [input, setInput] = useState("");
  const [streamingText, setStreamingText] = useState<string | undefined>();
  const [thinkingLabel, setThinkingLabel] = useState<string | undefined>();
  const [toolStatus, setToolStatus] = useState<string | undefined>();
  const [progress, setProgress] = useState<string | undefined>();
  const [stopMessage, setStopMessage] = useState<string | undefined>();
  const [modeMark, setModeMark] = useState(
    agentMark(chat.getMode(sessionId)),
  );
  const [permMarkState, setPermMarkState] = useState(
    permMark(chat.getPermissionMode(sessionId)),
  );
  const [pendingPrompt, setPendingPrompt] = useState<PermissionPrompt | null>(
    null,
  );
  const [cacheLine, setCacheLine] = useState<string | undefined>();
  const [compactLine, setCompactLine] = useState<string | undefined>();
  const [commandOutput, setCommandOutput] = useState<string | undefined>();
  const [completions, setCompletions] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [runningTasks, setRunningTasks] = useState<string[]>([]);
  const playRef = useRef<(events: AsyncIterable<AgentEvent>) => Promise<void>>(
    async () => {},
  );
  /** /clear 后只显示此下标之后的存档消息 */
  const viewStartRef = useRef(0);
  /** 递增后 Static 重新挂载，避免 /clear 后旧行仍占滚动区 */
  const [staticEpoch, setStaticEpoch] = useState(0);
  const titleRef = useRef(store.get(sessionId)?.title ?? "会话");
  const [title, setTitle] = useState(titleRef.current);
  const promptSessionRef = useRef<PromptSession | null>(null);
  if (!promptSessionRef.current) {
    promptSessionRef.current = createPromptSession(setPendingPrompt);
    // 同步挂上确认器，避免首条消息时仍是默认「直接拒绝」
    chat.attachPrompter(promptSessionRef.current.prompter);
  }

  useEffect(() => {
    const session = promptSessionRef.current;
    if (!session) return;
    chat.attachPrompter(session.prompter);
  }, [chat]);

  useEffect(() => {
    const timer = setInterval(() => {
      const next = chat.listSubAgents(sessionId).map((task) => {
        const where = task.background ? "后台" : "前台";
        return `${task.id} ${where}运行中`;
      });
      setRunningTasks((prev) =>
        prev.length === next.length && prev.every((line, i) => line === next[i])
          ? prev
          : next,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [chat, sessionId]);

  useEffect(() => {
    chat.setIdleDeliveryHandler((id) => {
      if (id !== sessionId) return;
      setBusy(true);
      void playRef.current(chat.followUp(sessionId));
    });
    return () => chat.setIdleDeliveryHandler(null);
  }, [chat, sessionId]);

  function syncMessagesFromStore() {
    const session = store.get(sessionId);
    const all = session?.messages ?? [];
    setMessages(all.slice(viewStartRef.current));
    const nextTitle = session?.title ?? "会话";
    if (nextTitle !== titleRef.current) {
      titleRef.current = nextTitle;
      setTitle(nextTitle);
    }
  }

  useInput((char, key) => {
    const promptSession = promptSessionRef.current;
    if (promptSession?.isWaiting()) {
      if (key.escape) {
        chat.cancelCurrent();
        promptSession.choose("deny");
        return;
      }
      if (char === "1") {
        promptSession.choose("deny");
        return;
      }
      if (char === "2") {
        promptSession.choose("once");
        return;
      }
      if (char === "3") {
        promptSession.choose("session");
        return;
      }
      if (char === "4") {
        promptSession.choose("permanent");
        return;
      }
      return;
    }

    if (key.escape) {
      if (busy) {
        chat.cancelCurrent();
        return;
      }
      onBack();
      return;
    }
    if (
      foregroundDetachKey({
        promptOpen: false,
        busy,
        char,
        ctrl: Boolean(key.ctrl),
        meta: Boolean(key.meta),
        hasForeground: chat.hasForegroundSubAgent(sessionId),
      })
    ) {
      chat.detachForegroundSubAgent(sessionId);
      return;
    }
    if (busy) return;

    if (key.tab) {
      if (input.trimStart().startsWith("/")) {
        const result = complete(input, chat.getCommandRegistry());
        if (result.single) {
          setInput(result.single + (input.endsWith(" ") ? " " : " "));
          setCompletions([]);
        } else if (result.candidates.length > 0) {
          setCompletions(result.candidates);
        } else {
          setCompletions([]);
        }
      }
      return;
    }

    if (key.return) {
      const text = input.trim();
      if (!text) return;
      setCompletions([]);
      void submit(text);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      setCompletions([]);
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      setInput((prev) => prev + char);
      setCompletions([]);
    }
  });

  async function submit(text: string) {
    setBusy(true);
    setError(undefined);
    setInput("");
    setStreamingText("");
    setThinkingLabel(undefined);
    setToolStatus(undefined);
    setProgress(undefined);
    setStopMessage(undefined);
    setCacheLine(undefined);
    setCompactLine(undefined);
    setCommandOutput(undefined);
    setCompletions([]);

    // 斜杠命令不乐观插入用户气泡
    const isSlash = text.startsWith("/");

    if (!isSlash) {
      const optimisticUser: ChatMessage = {
        id: `local-user-${Date.now()}`,
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimisticUser]);
    }

    await play(chat.send(sessionId, text));
  }

  async function play(events: AsyncIterable<AgentEvent>) {
    let acc = "";
    let thinkingAcc = "";
    let streamTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingStream: string | undefined;

    const flushStream = () => {
      streamTimer = null;
      if (pendingStream !== undefined) {
        setStreamingText(pendingStream);
        pendingStream = undefined;
      }
    };

    const scheduleStream = (text: string) => {
      pendingStream = text;
      if (streamTimer === null) {
        streamTimer = setTimeout(flushStream, 80);
      }
    };

    try {
      for await (const event of events) {
        if (event.type === "mode_changed") {
          setModeMark(agentMark(event.mode));
        }
        if (event.type === "permission_mode_changed") {
          setPermMarkState(permMark(event.mode));
        }
        if (event.type === "ui_message") {
          setCommandOutput(event.text);
        }
        if (event.type === "ui_clear") {
          viewStartRef.current =
            store.get(sessionId)?.messages.length ?? 0;
          setMessages([]);
          setStaticEpoch((n) => n + 1);
          setCommandOutput(undefined);
        }
        if (event.type === "permission_denied") {
          setToolStatus(event.message);
        }
        if (event.type === "token_usage") {
          if (!event.cacheAvailable) {
            setCacheLine("缓存：不可用（协议未返回命中字段）");
          } else {
            setCacheLine(
              `缓存：命中 ${event.cacheHitTokens ?? 0} / 未命中 ${event.cacheMissTokens ?? 0}`,
            );
          }
        }
        if (event.type === "compact_start") {
          const layer =
            event.layer === "micro" ? "轻量预防" : "重量摘要";
          setCompactLine(
            `正在压缩上下文（${layer}，${event.trigger === "manual" ? "手动" : "自动"}）…`,
          );
          syncMessagesFromStore();
        }
        if (event.type === "compact_done") {
          if (event.layer === "micro") {
            setCompactLine(
              `轻量预防完成：已落盘 ${event.spilledCount ?? 0} 个工具结果`,
            );
          } else {
            setCompactLine(
              `摘要压缩成功（移除约 ${event.removedMessageCount ?? 0} 条，保留 ${event.keptMessageCount ?? 0} 条）`,
            );
          }
          syncMessagesFromStore();
        }
        if (event.type === "compact_failed") {
          setCompactLine(
            `摘要压缩失败（连续 ${event.consecutiveFailures} 次）：${event.error}`,
          );
        }
        if (event.type === "compact_circuit_open") {
          setCompactLine(
            "自动压缩已熔断：请使用 /compact 手动压缩，或开启新会话",
          );
        }
        if (event.type === "agent_progress") {
          setProgress(`迭代 ${event.iteration}/${event.maxIterations}`);
          acc = "";
          pendingStream = undefined;
          setStreamingText("");
        }
        if (event.type === "agent_stopped") {
          setStopMessage(event.message);
        }
        if (event.type === "thinking_start") {
          setThinkingLabel("思考中…");
        }
        if (event.type === "thinking_delta") {
          thinkingAcc += event.text;
          const preview = thinkingAcc.replace(/\s+/g, " ").trim().slice(0, 40);
          const label = `思考中…（摘要预览：${preview}…）`;
          setThinkingLabel((prev) => (prev === label ? prev : label));
        }
        if (event.type === "thinking_end") {
          setThinkingLabel(`思考摘要：${event.summary}`);
        }
        if (event.type === "tool_call_start") {
          setToolStatus(`准备调用工具：${event.name}`);
        }
        if (event.type === "tool_execution_start") {
          setToolStatus(
            `正在执行 ${event.name}… 参数：${event.argsSummary}`,
          );
          syncMessagesFromStore();
          acc = "";
          pendingStream = undefined;
          setStreamingText(undefined);
        }
        if (event.type === "tool_execution_end") {
          setToolStatus(
            `${event.ok ? "成功" : "失败"} ${event.name}：${event.resultSummary}`,
          );
          syncMessagesFromStore();
          acc = "";
          pendingStream = undefined;
          setStreamingText("");
        }
        if (event.type === "text_delta") {
          acc += event.text;
          scheduleStream(acc);
        }
        if (event.type === "error") {
          setError(event.message);
          pendingStream = undefined;
          setStreamingText(undefined);
          setThinkingLabel(undefined);
          setToolStatus(undefined);
          syncMessagesFromStore();
        }
        if (event.type === "done") {
          if (streamTimer) {
            clearTimeout(streamTimer);
            streamTimer = null;
          }
          flushStream();
          syncMessagesFromStore();
          setStreamingText(undefined);
          setThinkingLabel(undefined);
          setToolStatus(undefined);
          setProgress(undefined);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStreamingText(undefined);
      setToolStatus(undefined);
    } finally {
      if (streamTimer) clearTimeout(streamTimer);
      setBusy(false);
    }
  }
  playRef.current = play;

  return (
    <>
      <MessageList
        messages={messages}
        staticEpoch={staticEpoch}
        streamingText={streamingText}
        thinkingLabel={thinkingLabel}
        toolStatus={toolStatus}
      />

      <Box flexDirection="column">
      <Text bold>
        MewCode — {title}{" "}
        <Text color="magenta">
          [{modeMark} · {permMarkState}]
        </Text>
      </Text>
      <Text dimColor>
        Enter 发送；Tab 补全斜杠命令；忙碌时 Esc 取消；前台子任务按 b 转入后台；空闲 Esc 返回
      </Text>
      {progress ? <Text color="blue">{progress}</Text> : null}
      {cacheLine ? <Text dimColor>{cacheLine}</Text> : null}
      {compactLine ? <Text color="yellow">{compactLine}</Text> : null}
      {stopMessage ? <Text color="green">状态：{stopMessage}</Text> : null}
      {runningTasks.map((line) => (
        <Text key={line} color="cyan">
          子任务 {line}
        </Text>
      ))}

      {warnings.map((w) => (
        <Text key={w} color="yellow">
          警告：{w}
        </Text>
      ))}

      {commandOutput ? (
        <Box marginBottom={1} flexDirection="column">
          <Text color="cyan">{commandOutput}</Text>
        </Box>
      ) : null}

      {completions.length > 0 ? (
        <Text dimColor>候选：{completions.join("  ")}</Text>
      ) : null}

      {pendingPrompt ? (
        <Box flexDirection="column">
          <Text color="yellow">
            需要确认：{pendingPrompt.tool}　参数：{pendingPrompt.subject}
          </Text>
          <Text color="yellow">1 拒绝　2 仅本次　3 本会话　4 永久</Text>
        </Box>
      ) : null}

      {error ? <Text color="red">错误：{error}</Text> : null}

      <Box>
        <Text color="cyan">
          {pendingPrompt ? "请选择" : busy ? "处理中" : "输入"}&gt;{" "}
        </Text>
        <Text>{pendingPrompt ? "" : input}</Text>
        {!busy && !pendingPrompt ? <Text dimColor>█</Text> : null}
      </Box>
      </Box>
    </>
  );
}
