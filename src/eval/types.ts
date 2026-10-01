/** Eval Runner 核心类型 */

export interface EvalCliArgs {
  taskId?: string;
  agentTimeoutMs: number;
  verifyTimeoutMs: number;
}

export interface TestCase {
  id: string;
  category: string;
  difficulty: string;
  fixtureDir: string;
  promptFile: string;
  verifyCommand: string;
  passCriteria?: string;
  failCriteria?: string;
}

export interface TestSet {
  version: number;
  tasks: TestCase[];
}

export interface TaskRunResult {
  taskId: string;
  category: string;
  difficulty: string;
  success: boolean;
  latencyMs: number;
  steps: number;
  workspacePath: string;
  error?: string;
  agentStopReason?: string;
  verifyExitCode?: number;
}

export interface EvalMetrics {
  taskSuccessRate: number;
  averageLatencyMs: number;
  averageSteps: number;
  passed: number;
  total: number;
}

export interface EvalReport {
  version: 1;
  createdAt: string;
  providerName?: string;
  model?: string;
  tasks: TaskRunResult[];
  metrics: EvalMetrics;
}

export interface EvalRunContext {
  repoRoot: string;
  runDir: string;
  evalRoot: string;
  args: EvalCliArgs;
}

export const DEFAULT_AGENT_TIMEOUT_MS = 300_000;
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
