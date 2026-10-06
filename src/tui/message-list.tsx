import React from "react";
import { Box, Static, Text } from "ink";
import type { ChatMessage } from "../session/types.js";

export interface MessageListProps {
  messages: ChatMessage[];
  /** /clear 等需要丢弃已打印 Static 行时递增 */
  staticEpoch?: number;
  /** 正在流式输出的助手正文 */
  streamingText?: string;
  /** 流式中的思考摘要/状态 */
  thinkingLabel?: string;
  /** 工具执行状态行 */
  toolStatus?: string;
}

/** 已完成的消息：写入 Static 后不再随流式重绘 */
export function CommittedMessage({ message: m }: { message: ChatMessage }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={roleColor(m.role)}>
        {roleLabel(m)}
      </Text>
      {m.thinkingSummary ? (
        <Text dimColor>思考摘要：{m.thinkingSummary}</Text>
      ) : null}
      {m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0
        ? m.toolCalls.map((tc) => (
            <Text key={tc.id} dimColor color="magenta">
              工具调用：{tc.name}
              {tc.ignored ? "（已忽略）" : ""}
              {" — "}
              {typeof tc.arguments === "string"
                ? tc.arguments.slice(0, 120)
                : JSON.stringify(tc.arguments).slice(0, 120)}
            </Text>
          ))
        : null}
      {m.role === "tool" ? (
        <Text color={m.isError ? "red" : "gray"}>
          {m.isError ? "失败" : "成功"}：{m.content.slice(0, 300)}
          {m.content.length > 300 ? "…" : ""}
        </Text>
      ) : m.content ? (
        <Text>{m.content}</Text>
      ) : null}
    </Box>
  );
}

export function MessageList({
  messages,
  staticEpoch = 0,
  streamingText,
  thinkingLabel,
  toolStatus,
}: MessageListProps) {
  return (
    <>
      <Static key={staticEpoch} items={messages}>
        {(m) => <CommittedMessage key={m.id} message={m} />}
      </Static>

      {thinkingLabel ? (
        <Text dimColor color="yellow">
          {thinkingLabel}
        </Text>
      ) : null}

      {toolStatus ? (
        <Text dimColor color="magenta">
          {toolStatus}
        </Text>
      ) : null}

      {streamingText !== undefined ? (
        <Box flexDirection="column">
          <Text bold color="green">
            助手
          </Text>
          <Text>{streamingText || "…"}</Text>
        </Box>
      ) : null}
    </>
  );
}

function roleLabel(m: ChatMessage): string {
  if (m.role === "user") return "你";
  if (m.role === "assistant") return "助手";
  if (m.role === "tool") return `工具结果${m.toolName ? `（${m.toolName}）` : ""}`;
  return "系统";
}

function roleColor(role: ChatMessage["role"]): string {
  if (role === "user") return "cyan";
  if (role === "assistant") return "green";
  if (role === "tool") return "magenta";
  return "white";
}
