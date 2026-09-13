import React from "react";
import { Box, Text } from "ink";

/** 启动页小狗头像（ASCII，兼容常见终端字体） */
const DOG_LINES = [
  "  /\\___/\\",
  " (  o o  )",
  " /   ▽   \\",
  " \\__\\|\\|__/",
];

export function DogAvatar() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {DOG_LINES.map((line) => (
        <Text key={line} color="yellow">
          {line}
        </Text>
      ))}
      <Text bold color="magenta">
        MewCode
      </Text>
    </Box>
  );
}
