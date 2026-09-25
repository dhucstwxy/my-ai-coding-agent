import { randomBytes } from "node:crypto";

/** 生成 YYYYMMDD-HHMMSS-xxxx 形式的会话 ID */
export function generateSessionId(now = new Date()): string {
  const y = now.getFullYear().toString().padStart(4, "0");
  const mo = (now.getMonth() + 1).toString().padStart(2, "0");
  const d = now.getDate().toString().padStart(2, "0");
  const h = now.getHours().toString().padStart(2, "0");
  const mi = now.getMinutes().toString().padStart(2, "0");
  const s = now.getSeconds().toString().padStart(2, "0");
  const suffix = randomBytes(3).toString("hex"); // 6 hex chars
  return `${y}${mo}${d}-${h}${mi}${s}-${suffix}`;
}
