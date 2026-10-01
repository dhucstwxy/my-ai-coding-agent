import { execFileSync } from "node:child_process";
import type { MemberBackend } from "./types.js";

export interface BackendDetect {
  pane: boolean;
  inprocess: boolean;
}

export interface BackendSelectOptions {
  /** 测试用：假装选中 pane 但随后不可用 */
  forcePaneUnavailable?: boolean;
}

export function detectBackends(): BackendDetect {
  return {
    pane: isTmuxAvailable(),
    inprocess: true,
  };
}

export function selectBackend(opts: BackendSelectOptions = {}): MemberBackend {
  const d = detectBackends();
  if (opts.forcePaneUnavailable) {
    throw new Error(
      "后端 pane 不可用：强制失败（测试）。不会降级为 inprocess。",
    );
  }
  if (d.pane) return "pane";
  if (d.inprocess) return "inprocess";
  throw new Error("没有可用的成员运行后端");
}

/** 尝试唤醒 tmux 窗格；失败返回 false，不抛错。 */
export function wakePane(handle: string): boolean {
  if (!handle || !isTmuxAvailable()) return false;
  try {
    execFileSync("tmux", ["select-pane", "-t", handle], {
      stdio: "pipe",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 在当前 tmux 窗口拆分并启动命令，返回 pane id。
 * 不在 tmux 内时抛错（由调用方保证仅 pane 路径调用）。
 */
export function spawnTmuxPane(command: string, cwd: string): string {
  if (!isTmuxAvailable()) {
    throw new Error("后端 pane 不可用：未检测到 tmux。不会降级为 inprocess。");
  }
  try {
    const out = execFileSync(
      "tmux",
      ["split-window", "-P", "-F", "#{pane_id}", "-c", cwd, command],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const id = out.trim().split(/\r?\n/)[0]?.trim();
    if (!id) throw new Error("tmux 未返回 pane id");
    return id;
  } catch (err) {
    throw new Error(
      `后端 pane 不可用：${err instanceof Error ? err.message : String(err)}。不会降级为 inprocess。`,
    );
  }
}

function isTmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "pipe", windowsHide: true });
    // 还需要在 tmux 会话内才算真正可用
    if (!process.env.TMUX) return false;
    return true;
  } catch {
    return false;
  }
}
