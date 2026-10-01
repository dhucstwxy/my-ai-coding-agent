import type { EvalMetrics, TaskRunResult } from "./types.js";

export function computeMetrics(results: TaskRunResult[]): EvalMetrics {
  const total = results.length;
  if (total === 0) {
    return {
      taskSuccessRate: 0,
      averageLatencyMs: 0,
      averageSteps: 0,
      passed: 0,
      total: 0,
    };
  }
  const passed = results.filter((r) => r.success).length;
  const averageLatencyMs =
    results.reduce((sum, r) => sum + r.latencyMs, 0) / total;
  const averageSteps =
    results.reduce((sum, r) => sum + r.steps, 0) / total;
  return {
    taskSuccessRate: passed / total,
    averageLatencyMs,
    averageSteps,
    passed,
    total,
  };
}
