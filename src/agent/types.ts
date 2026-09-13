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
  | { type: "token_usage"; inputTokens?: number; outputTokens?: number }
  | { type: "agent_stopped"; reason: StopReason; message: string }
  | { type: "mode_changed"; mode: AgentMode };

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
  usage?: { inputTokens?: number; outputTokens?: number };
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
