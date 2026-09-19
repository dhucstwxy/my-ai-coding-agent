import type { PermissionMode } from "./types.js";

/** 会话级权限档位，只存在内存里。 */
export class PermissionModeStore {
  private readonly modes = new Map<string, PermissionMode>();

  get(sessionId: string): PermissionMode {
    return this.modes.get(sessionId) ?? "default";
  }

  set(sessionId: string, mode: PermissionMode): void {
    this.modes.set(sessionId, mode);
  }
}
