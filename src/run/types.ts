/** 无头 run 的结果报告类型 */

export interface RunToolRecord {
  id: string;
  name: string;
  ok: boolean;
  ms: number;
  summary?: string;
}

export interface RunReport {
  version: 1;
  runId: string;
  startedAt: string;
  endedAt: string;
  exitCode: number;
  workspace: string;
  prompt: string;
  promptSource: "arg" | "file";
  providerName?: string;
  model?: string;
  steps: number;
  latencyMs: number;
  stopReason?: string;
  finalMessage: string;
  tools: RunToolRecord[];
  sessionId?: string;
  sessionPath?: string;
  error: string | null;
}

export interface RunCliArgs {
  prompt?: string;
  promptFile?: string;
  workspace: string;
  outPath?: string;
  timeoutMs: number;
  help: boolean;
}

export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
