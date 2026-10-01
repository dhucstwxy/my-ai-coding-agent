import fs from "node:fs";
import path from "node:path";
import type { TestCase, TestSet } from "./types.js";

export function loadTestSet(evalRoot: string): TestSet {
  const file = path.join(evalRoot, "test_set.json");
  if (!fs.existsSync(file)) {
    throw new Error(`找不到题库：${file}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as TestSet;
  if (!raw || typeof raw.version !== "number" || !Array.isArray(raw.tasks)) {
    throw new Error("test_set.json 格式无效：需要 version 与 tasks 数组");
  }
  for (const task of raw.tasks) {
    if (!task.id || !task.fixtureDir || !task.verifyCommand) {
      throw new Error(`题目缺少必要字段：${JSON.stringify(task)}`);
    }
  }
  return raw;
}

export function selectTasks(set: TestSet, taskId?: string): TestCase[] {
  if (!taskId) return [...set.tasks];
  const found = set.tasks.find((t) => t.id === taskId);
  if (!found) {
    throw new Error(`未知任务 ID：${taskId}`);
  }
  return [found];
}
