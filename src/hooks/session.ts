import type { HookEngine } from "./engine.js";
import type { HookSessionState } from "./state.js";

export interface HookSessions {
  current(): string | null;
  enter(sessionId: string): Promise<void>;
  leave(sessionId: string): Promise<void>;
}

/**
 * 进入会话发 session_start。离开或进程退出发 session_end 并清掉该会话状态。
 * 重复离开只生效一次。
 */
export function createHookSessions(
  engine: HookEngine,
  state: HookSessionState,
): HookSessions {
  let currentId: string | null = null;
  const open = new Set<string>();

  return {
    current: () => currentId,
    async enter(sessionId: string) {
      open.add(sessionId);
      currentId = sessionId;
      await engine.dispatch({ event: "session_start", sessionId });
    },
    async leave(sessionId: string) {
      if (!open.has(sessionId)) return;
      open.delete(sessionId);
      if (currentId === sessionId) currentId = null;
      await engine.dispatch({ event: "session_end", sessionId });
      state.clear(sessionId);
    },
  };
}
