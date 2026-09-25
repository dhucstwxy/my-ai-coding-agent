import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  memoryIndexPath,
  memoryNotesDir,
  type MemoryScope,
} from "./paths.js";

export type MemoryNoteType =
  | "user_preference"
  | "feedback"
  | "project_knowledge"
  | "reference";

export interface MemoryNote {
  id: string;
  type: MemoryNoteType;
  scope: MemoryScope;
  createdAt: string;
  updatedAt: string;
  title?: string;
  body: string;
}

function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  if (!raw.startsWith("---")) {
    return { meta: {}, body: raw };
  }
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: raw };
  const fm = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const meta: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    meta[key] = val;
  }
  return { meta, body };
}

function serializeNote(note: MemoryNote): string {
  const lines = [
    "---",
    `id: ${note.id}`,
    `type: ${note.type}`,
    `scope: ${note.scope}`,
    `createdAt: ${note.createdAt}`,
    `updatedAt: ${note.updatedAt}`,
  ];
  if (note.title) lines.push(`title: ${note.title}`);
  lines.push("---", "", note.body.trim(), "");
  return lines.join("\n");
}

export function writeNote(workspaceRoot: string, note: MemoryNote): string {
  const dir = memoryNotesDir(note.scope, workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${note.id}.md`);
  fs.writeFileSync(filePath, serializeNote(note), "utf8");
  return filePath;
}

export function writeIndexFile(
  scope: MemoryScope,
  workspaceRoot: string,
  content: string,
): void {
  const p = memoryIndexPath(scope, workspaceRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

export function createNoteId(): string {
  return randomUUID();
}

export function noteFromParsed(
  scope: MemoryScope,
  raw: string,
  fileId?: string,
): MemoryNote | null {
  const { meta, body } = parseFrontmatter(raw);
  const type = meta.type as MemoryNoteType | undefined;
  const valid: MemoryNoteType[] = [
    "user_preference",
    "feedback",
    "project_knowledge",
    "reference",
  ];
  if (!type || !valid.includes(type)) return null;
  const now = new Date().toISOString();
  return {
    id: meta.id || fileId || createNoteId(),
    type,
    scope: (meta.scope as MemoryScope) || scope,
    createdAt: meta.createdAt || now,
    updatedAt: meta.updatedAt || now,
    title: meta.title,
    body,
  };
}
