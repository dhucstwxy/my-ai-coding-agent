import path from "node:path";
import {
  projectMemoryDir,
  userMemoryDir,
} from "../config/paths.js";

export type MemoryScope = "user" | "project";

export function memoryRoot(
  scope: MemoryScope,
  workspaceRoot: string,
): string {
  return scope === "project"
    ? projectMemoryDir(workspaceRoot)
    : userMemoryDir();
}

export function memoryIndexPath(
  scope: MemoryScope,
  workspaceRoot: string,
): string {
  return path.join(memoryRoot(scope, workspaceRoot), "INDEX.md");
}

export function memoryNotesDir(
  scope: MemoryScope,
  workspaceRoot: string,
): string {
  return path.join(memoryRoot(scope, workspaceRoot), "notes");
}
