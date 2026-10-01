import path from "node:path";
import { validateName } from "./name.js";
import type { WorktreeService } from "./service.js";

export interface JanitorOptions {
  /** 扫描间隔，默认 1 小时 */
  intervalMs?: number;
  /** 未使用超过此时长才候选，默认 7 天 */
  ttlMs?: number;
  /** 立即跑一轮（测试用） */
  runImmediately?: boolean;
}

const HOUR = 60 * 60 * 1000;
const DAY7 = 7 * 24 * HOUR;

/**
 * 后台清理过期 worktree。
 * 三层过滤：活跃 / 有变更 / 路径不安全 → 跳过。
 */
export function startWorktreeJanitor(
  service: WorktreeService,
  opts: JanitorOptions = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? HOUR;
  const ttlMs = opts.ttlMs ?? DAY7;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const items = await service.list();
      const now = Date.now();
      for (const item of items) {
        if (stopped) return;
        const v = validateName(item.name);
        if (!v.ok) continue;
        const expected = service.absolutePath(v.name);
        if (path.resolve(expected) !== path.resolve(item.path)) continue;
        if (service.isActive(v.name)) continue;
        const last = service.lastUsedAt(v.name) ?? 0;
        // 无元数据时保守跳过，避免误删本进程未管理过的目录
        if (!last) continue;
        if (now - last < ttlMs) continue;
        const dirty = await service.isDirty(v.name);
        if (dirty.blocked) continue;
        try {
          await service.remove(v.name);
        } catch (err) {
          console.error(
            `[worktree] 清理失败 ${v.name}：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[worktree] 清理扫描失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  if (opts.runImmediately) {
    void tick();
  }
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
