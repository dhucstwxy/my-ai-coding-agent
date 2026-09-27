import type { AgentMode } from "../agent/types.js";
import type { PermissionMode } from "../permission/types.js";
import type { TokenUsageInfo } from "../agent/types.js";

/** 命令类型：本地确定 / 影响界面或会话状态 / 送入 AI 的提示词 */
export type CommandType = "local" | "ui" | "prompt";

export interface StatusSnapshot {
  agentMode: AgentMode;
  permissionMode: PermissionMode;
  sessionId: string;
  sessionTitle: string;
  messageCount: number;
  sessionPath: string;
  tokenUsage?: TokenUsageInfo;
  compactCircuitOpen: boolean;
}

export interface MemoryScopeInfo {
  scope: "project" | "user";
  path: string;
  exists: boolean;
  lineCount?: number;
  byteSize?: number;
}

export interface SessionInfo {
  id: string;
  title: string;
  messageCount: number;
  path: string;
}

/** 命令通过此端口操作界面与会话，不依赖 Ink */
export interface UiPort {
  showMessage(text: string): void;
  clearScreen(): void;
  submitToAgent(text: string): Promise<void>;
  setAgentMode(mode: AgentMode): void;
  setPermissionMode(mode: PermissionMode): void;
  getStatusSnapshot(): StatusSnapshot;
}

export interface CommandContext {
  sessionId: string;
  workspaceRoot: string;
  ui: UiPort;
  runCompact(note: string): Promise<void>;
  getSessionInfo(): SessionInfo | null;
  getMemoryInfo(): MemoryScopeInfo[];
  clearActivatedSkills(): void;
}

export interface CommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  type: CommandType;
  argsHint?: string;
  hidden?: boolean;
  handler: (
    ctx: CommandContext,
    args: string,
  ) => void | Promise<void>;
}

export type ParseResult =
  | { kind: "empty" }
  | { kind: "not_command"; text: string }
  | { kind: "command"; name: string; args: string };

export type DispatchResult =
  | { handled: false; text: string }
  | { handled: true; unknown?: false }
  | { handled: true; unknown: true; name: string };

export interface CompleteResult {
  single?: string;
  candidates: string[];
}
