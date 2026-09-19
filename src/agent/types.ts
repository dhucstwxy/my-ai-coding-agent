import type { PermissionDecision, PermissionMode } from "../permission/types.js";
import type { StreamEvent } from "../provider/types.js";

export type AgentMode = "plan" | "execute";

export type StopReason =
  | "completed"
  | "max_iterations"
  | "cancelled"
  | "unknown_tools"
  | "error";

export type AgentEvent =
  | StreamEvent
  | { type: "agent_progress"; iteration: number; maxIterations: number }
  | { type: "agent_stopped"; reason: StopReason; message: string }
  | { type: "mode_changed"; mode: AgentMode }
  | {
      type: "permission_prompt";
      id: string;
      tool: string;
      subject: string;
      argsSummary: string;
    }
  | {
      type: "permission_denied";
      id: string;
      tool: string;
      reason: PermissionDecision["reason"];
      message: string;
    }
  | { type: "permission_mode_changed"; mode: PermissionMode };

export interface TokenUsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  cacheAvailable: boolean;
}

export interface CollectedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
  parseError?: string;
}

export interface CollectedTurn {
  text: string;
  toolCalls: CollectedToolCall[];
  thinkingSummary?: string;
  usage?: TokenUsageInfo;
  errorMessage?: string;
}

export interface AgentLoopOptions {
  maxIterations: number;
  unknownToolLimit: number;
  toolTimeoutMs: number;
}

export const DEFAULT_AGENT_OPTIONS: AgentLoopOptions = {
  maxIterations: 20,
  unknownToolLimit: 2,
  toolTimeoutMs: 30_000,
};

export const PLAN_READONLY_TOOLS = [
  "read_file",
  "glob_files",
  "grep_search",
] as const;
