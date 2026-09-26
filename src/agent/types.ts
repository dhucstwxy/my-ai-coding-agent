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
  | { type: "permission_mode_changed"; mode: PermissionMode }
  | {
      type: "compact_start";
      layer: "micro" | "auto";
      trigger: "auto" | "manual";
    }
  | {
      type: "compact_done";
      layer: "micro" | "auto";
      spilledCount?: number;
      removedMessageCount?: number;
      keptMessageCount?: number;
    }
  | {
      type: "compact_failed";
      layer: "auto";
      error: string;
      consecutiveFailures: number;
    }
  | { type: "compact_circuit_open" };

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
  /** 连续「只有工具调用、无正文」的轮数上限，避免空转打满 maxIterations */
  maxToolOnlyIterations: number;
  /** 连续整批权限拒绝的轮数上限 */
  maxPermissionDenyIterations: number;
}

export const DEFAULT_AGENT_OPTIONS: AgentLoopOptions = {
  maxIterations: 20,
  unknownToolLimit: 2,
  toolTimeoutMs: 30_000,
  maxToolOnlyIterations: 8,
  maxPermissionDenyIterations: 3,
};

const PERMISSION_ERROR_CODES = new Set([
  "blacklist",
  "sandbox",
  "rule",
  "mode",
  "user",
  "write_failed",
]);

export function isPermissionErrorCode(code: string | undefined): boolean {
  return Boolean(code && PERMISSION_ERROR_CODES.has(code));
}

export const PLAN_READONLY_TOOLS = [
  "read_file",
  "glob_files",
  "grep_search",
] as const;
