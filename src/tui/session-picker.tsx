import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionSummary } from "../session/types.js";

export interface SessionPickerProps {
  sessions: SessionSummary[];
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
}

export function SessionPicker({
  sessions,
  onSelect,
  onCreate,
}: SessionPickerProps) {
  // 选项：0 = 新建，其后为历史会话
  const [selected, setSelected] = useState(0);
  const itemCount = sessions.length + 1;

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelected((i) => (i - 1 + itemCount) % itemCount);
    } else if (key.downArrow) {
      setSelected((i) => (i + 1) % itemCount);
    } else if (key.return) {
      if (selected === 0) {
        onCreate();
      } else {
        onSelect(sessions[selected - 1]!.id);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>MewCode — 选择会话</Text>
      <Text dimColor>↑/↓ 移动，Enter 确认</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text color={selected === 0 ? "blue" : undefined}>
          {selected === 0 ? "❯ " : "  "}新建会话
        </Text>
        {sessions.map((s, i) => {
          const idx = i + 1;
          const active = selected === idx;
          return (
            <Text key={s.id} color={active ? "blue" : undefined}>
              {active ? "❯ " : "  "}
              {s.title}{" "}
              <Text dimColor>({formatTime(s.updatedAt)})</Text>
            </Text>
          );
        })}
        {sessions.length === 0 ? (
          <Text dimColor>  （暂无历史会话）</Text>
        ) : null}
      </Box>
    </Box>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
