import fs from "node:fs";
import { memoryIndexPath } from "./paths.js";

export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25_000;

export interface MemoryLoadResult {
  text: string;
  warnings: string[];
}

function readIndex(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/** 按行数与字节上限截断，保留靠前内容 */
export function truncateIndexText(text: string): string {
  let lines = text.split(/\r?\n/);
  if (lines.length > MEMORY_INDEX_MAX_LINES) {
    lines = lines.slice(0, MEMORY_INDEX_MAX_LINES);
  }
  let out = lines.join("\n");
  while (Buffer.byteLength(out, "utf8") > MEMORY_INDEX_MAX_BYTES) {
    lines = out.split(/\r?\n/);
    if (lines.length <= 1) {
      out = out.slice(0, Math.floor(out.length * 0.9));
      break;
    }
    lines.pop();
    out = lines.join("\n");
  }
  return out;
}

/** 项目索引在前，用户索引在后 */
export function loadMemoryText(workspaceRoot: string): MemoryLoadResult {
  const warnings: string[] = [];
  const project = readIndex(memoryIndexPath("project", workspaceRoot)).trim();
  const user = readIndex(memoryIndexPath("user", workspaceRoot)).trim();
  const parts: string[] = [];
  if (project) parts.push("## 项目记忆索引\n\n" + project);
  if (user) parts.push("## 用户记忆索引\n\n" + user);
  let text = parts.join("\n\n");
  const before = text;
  text = truncateIndexText(text);
  if (text !== before) {
    warnings.push("记忆索引超过 200 行或 25KB，注入时已截断");
  }
  return { text, warnings };
}
