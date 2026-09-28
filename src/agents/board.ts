import { randomUUID } from "node:crypto";
import type { SubAgentStatus, SubAgentTask } from "./types.js";

/** 进程内任务表、前台计时和待送回队列。 */
export class TaskBoard {
  private readonly tasks = new Map<string, SubAgentTask>();
  private readonly queue = new Map<string, string[]>();

  create(task: Omit<SubAgentTask, "id" | "usage" | "runningMs" | "status"> & {
    status?: SubAgentStatus;
  }): SubAgentTask {
    const created: SubAgentTask = {
      ...task,
      id: randomUUID(),
      status: task.status ?? "running",
      usage: { inputTokens: 0, outputTokens: 0 },
      runningMs: 0,
    };
    this.tasks.set(created.id, created);
    return created;
  }

  get(id: string): SubAgentTask | undefined {
    return this.tasks.get(id);
  }

  listRunning(parentSessionId: string): SubAgentTask[] {
    return [...this.tasks.values()].filter(
      (task) => task.parentSessionId === parentSessionId && task.status === "running",
    );
  }

  isChildSession(sessionId: string): boolean {
    return [...this.tasks.values()].some((task) => task.childSessionId === sessionId);
  }

  markBackground(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.background = true;
  }

  finish(id: string, status: Exclude<SubAgentStatus, "running">, finalText: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return;
    task.status = status;
    task.finalText = finalText;
  }

  addUsage(id: string, inputTokens: number, outputTokens: number): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.usage.inputTokens += inputTokens;
    task.usage.outputTokens += outputTokens;
  }

  addRunningMs(id: string, ms: number): void {
    const task = this.tasks.get(id);
    if (!task || ms <= 0) return;
    task.runningMs += ms;
  }

  enqueue(parentSessionId: string, text: string): void {
    const list = this.queue.get(parentSessionId) ?? [];
    list.push(text);
    this.queue.set(parentSessionId, list);
  }

  drain(parentSessionId: string): string[] {
    const list = this.queue.get(parentSessionId) ?? [];
    this.queue.delete(parentSessionId);
    return list;
  }

  /** 把名下仍在跑的任务标为取消，并清掉待送回队列。调用方负责停掉循环。 */
  clearParent(parentSessionId: string): void {
    for (const task of this.tasks.values()) {
      if (task.parentSessionId === parentSessionId && task.status === "running") {
        task.status = "cancelled";
      }
    }
    this.queue.delete(parentSessionId);
  }
}
