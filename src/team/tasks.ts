import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { tasksJsonPath } from "./paths.js";
import type { TeamTask, TeamTaskStatus } from "./types.js";

export class TeamTaskStore {
  constructor(private readonly rootPath: string) {
    if (!fs.existsSync(tasksJsonPath(rootPath))) {
      this.write([]);
    }
  }

  list(): TeamTask[] {
    return this.read();
  }

  add(input: {
    title: string;
    description?: string;
    dependsOn?: string[];
    assignee?: string;
    status?: TeamTaskStatus;
  }): TeamTask {
    const task: TeamTask = {
      id: randomUUID(),
      title: input.title.trim(),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      dependsOn: input.dependsOn ?? [],
      ...(input.assignee ? { assignee: input.assignee } : {}),
      status: input.status ?? "open",
    };
    if (!task.title) throw new Error("任务标题不能为空");
    const all = this.read();
    all.push(task);
    this.write(all);
    return task;
  }

  update(
    id: string,
    patch: Partial<Omit<TeamTask, "id">>,
  ): TeamTask {
    const all = this.read();
    const idx = all.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error(`找不到任务：${id}`);
    all[idx] = { ...all[idx]!, ...patch, id };
    this.write(all);
    return all[idx]!;
  }

  remove(id: string): boolean {
    const all = this.read();
    const next = all.filter((t) => t.id !== id);
    if (next.length === all.length) return false;
    this.write(next);
    return true;
  }

  private read(): TeamTask[] {
    const file = tasksJsonPath(this.rootPath);
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, "utf8")) as TeamTask[];
  }

  private write(tasks: TeamTask[]): void {
    fs.writeFileSync(
      tasksJsonPath(this.rootPath),
      JSON.stringify(tasks, null, 2) + "\n",
      "utf8",
    );
  }
}
