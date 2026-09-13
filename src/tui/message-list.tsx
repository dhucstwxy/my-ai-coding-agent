import React from "react";
import { Box, Text } from "ink";
import type { ChatMessage } from "../session/types.js";

export interface MessageListProps {
  messages: ChatMessage[];
  /** 正在流式输出的助手正文 */
  streamingText?: string;
  /** 流式中的思考摘要/状态 */
  thinkingLabel?: string;
}

export function MessageList({
  messages,
  streamingText,
  thinkingLabel,
}: MessageListProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {messages.map((m) => (
        <Box key={m.id} flexDirection="column" marginBottom={1}>
          <Text bold color={m.role === "user" ? "cyan" : "green"}>
            {roleLabel(m.role)}
          </Text>
          {m.thinkingSummary ? (
            <Text dimColor>思考摘要：{m.thinkingSummary}</Text>
          ) : null}
          <Text>{m.content}</Text>
        </Box>
      ))}

      {thinkingLabel ? (
        <Text dimColor color="yellow">
          {thinkingLabel}
        </Text>
      ) : null}

      {streamingText !== undefined && streamingText.length >= 0 ? (
        <Box flexDirection="column" marginTop={thinkingLabel ? 0 : 0}>
          <Text bold color="green">
            助手
          </Text>
          <Text>{streamingText || "…"}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function roleLabel(role: ChatMessage["role"]): string {
  if (role === "user") return "你";
  if (role === "assistant") return "助手";
  return "系统";
}
