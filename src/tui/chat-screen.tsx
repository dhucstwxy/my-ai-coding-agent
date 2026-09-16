import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ChatService } from "../chat/service.js";
import type { SessionStore } from "../session/store.js";
import type { ChatMessage } from "../session/types.js";
import { MessageList } from "./message-list.js";

export interface ChatScreenProps {
  sessionId: string;
  store: SessionStore;
  chat: ChatService;
  warnings: string[];
  onBack: () => void;
}

export function ChatScreen({
  sessionId,
  store,
  chat,
  warnings,
  onBack,
}: ChatScreenProps) {
  const initial = store.get(sessionId);
  const [messages, setMessages] = useState<ChatMessage[]>(
    initial?.messages ?? [],
  );
  const [input, setInput] = useState("");
  const [streamingText, setStreamingText] = useState<string | undefined>();
  const [thinkingLabel, setThinkingLabel] = useState<string | undefined>();
  const [toolStatus, setToolStatus] = useState<string | undefined>();
  const [progress, setProgress] = useState<string | undefined>();
  const [stopMessage, setStopMessage] = useState<string | undefined>();
  const [modeLabel, setModeLabel] = useState(
    chat.getMode(sessionId) === "plan" ? "计划模式" : "执行模式",
  );
  const [cacheLine, setCacheLine] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useInput((char, key) => {
    if (key.escape) {
      if (busy) {
        chat.cancelCurrent();
        return;
      }
      onBack();
      return;
    }
    if (busy) return;

    if (key.return) {
      const text = input.trim();
      if (!text) return;
      void submit(text);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      setInput((prev) => prev + char);
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

    const optimisticUser: ChatMessage = {
      id: `local-user-${Date.now()}`,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);

    let acc = "";
    let thinkingAcc = "";

    try {
      for await (const event of chat.send(sessionId, text)) {
        if (event.type === "mode_changed") {
          setModeLabel(event.mode === "plan" ? "计划模式" : "执行模式");
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
        if (event.type === "agent_progress") {
          setProgress(`迭代 ${event.iteration}/${event.maxIterations}`);
          acc = "";
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
          setThinkingLabel(
            `思考中…（摘要预览：${thinkingAcc.replace(/\s+/g, " ").trim().slice(0, 40)}…）`,
          );
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
          const mid = store.get(sessionId);
          setMessages(mid?.messages ?? []);
          acc = "";
          setStreamingText(undefined);
        }
        if (event.type === "tool_execution_end") {
          setToolStatus(
            `${event.ok ? "成功" : "失败"} ${event.name}：${event.resultSummary}`,
          );
          const mid = store.get(sessionId);
          setMessages(mid?.messages ?? []);
          acc = "";
          setStreamingText("");
        }
        if (event.type === "text_delta") {
          acc += event.text;
          setStreamingText(acc);
        }
        if (event.type === "error") {
          setError(event.message);
          setStreamingText(undefined);
          setThinkingLabel(undefined);
          setToolStatus(undefined);
          const latest = store.get(sessionId);
          setMessages(latest?.messages ?? []);
        }
        if (event.type === "done") {
          const latest = store.get(sessionId);
          setMessages(latest?.messages ?? []);
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
      setBusy(false);
    }
  }

  const title = store.get(sessionId)?.title ?? "会话";

  return (
    <Box flexDirection="column">
      <Text bold>
        MewCode — {title}{" "}
        <Text color="magenta">[{modeLabel}]</Text>
      </Text>
      <Text dimColor>
        Enter 发送；忙碌时 Esc 取消任务；空闲 Esc 返回列表；/plan /do 切换模式
      </Text>
      {progress ? <Text color="blue">{progress}</Text> : null}
      {cacheLine ? <Text dimColor>{cacheLine}</Text> : null}
      {stopMessage ? <Text color="green">状态：{stopMessage}</Text> : null}

      {warnings.map((w) => (
        <Text key={w} color="yellow">
          警告：{w}
        </Text>
      ))}

      <Box marginY={1} flexDirection="column">
        <MessageList
          messages={messages}
          streamingText={streamingText}
          thinkingLabel={thinkingLabel}
          toolStatus={toolStatus}
        />
      </Box>

      {error ? <Text color="red">错误：{error}</Text> : null}

      <Box>
        <Text color="cyan">{busy ? "处理中" : "输入"}&gt; </Text>
        <Text>{input}</Text>
        {!busy ? <Text dimColor>█</Text> : null}
      </Box>
    </Box>
  );
}
