import fs from "node:fs";
import path from "node:path";
import type { EvalReport } from "./types.js";

export function writeReport(runDir: string, report: EvalReport): string {
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, "eval-report.json");
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", "utf8");
  return file;
}

export function printSummary(report: EvalReport): void {
  const m = report.metrics;
  console.log("");
  console.log("======== Eval Summary ========");
  console.log(`通过：${m.passed}/${m.total}`);
  console.log(`Task Success Rate：${(m.taskSuccessRate * 100).toFixed(1)}%`);
  console.log(`Average Latency：${m.averageLatencyMs.toFixed(0)} ms`);
  console.log(`Average Steps：${m.averageSteps.toFixed(2)}`);
  if (report.providerName || report.model) {
    console.log(
      `模型：${report.providerName ?? "-"} / ${report.model ?? "-"}`,
    );
  }
  const failed = report.tasks.filter((t) => !t.success);
  if (failed.length > 0) {
    console.log("失败题目：");
    for (const t of failed) {
      console.log(`  - ${t.taskId}${t.error ? ` (${t.error})` : ""}`);
    }
  }
  console.log("==============================");
}
