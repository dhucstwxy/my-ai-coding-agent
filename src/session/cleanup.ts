import fs from "node:fs";
import path from "node:path";
import { scanSummary } from "./jsonl.js";

export const SESSION_TTL_DAYS = 30;

export function cleanupExpiredSessions(
  sessionsDir: string,
  now = new Date(),
): { removed: string[] } {
  const removed: string[] = [];
  if (!fs.existsSync(sessionsDir)) return { removed };
  const cutoff = now.getTime() - SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  for (const file of files) {
    const full = path.join(sessionsDir, file);
    const summary = scanSummary(full);
    const id = summary?.id ?? path.basename(file, ".jsonl");
    let updatedMs = 0;
    if (summary?.updatedAt) {
      updatedMs = Date.parse(summary.updatedAt);
    }
    if (!updatedMs) {
      try {
        updatedMs = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
    }
    if (updatedMs >= cutoff) continue;

    try {
      fs.unlinkSync(full);
    } catch {
      continue;
    }
    const side = path.join(sessionsDir, id);
    if (fs.existsSync(side)) {
      fs.rmSync(side, { recursive: true, force: true });
    }
    removed.push(id);
  }
  return { removed };
}
