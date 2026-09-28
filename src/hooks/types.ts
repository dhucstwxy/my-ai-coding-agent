/** 九个生命周期事件。只有 pre_tool 可以拦截工具。 */
export type HookEvent =
  | "session_start"
  | "session_end"
  | "turn_start"
  | "turn_end"
  | "user_message"
  | "assistant_message"
  | "pre_tool"
  | "post_tool"
  | "compact";

export type HookSource = "user" | "project" | "local";

export type HookMatch = "all" | "any";

export interface HookCondition {
  tool: string;
  pattern: string;
}

export type HookAction =
  | { type: "command"; command: string }
  | { type: "prompt"; text: string }
  | { type: "http"; url: string; method: string; body?: string }
  | { type: "subagent"; name: string };

/** 加载并校验通过后的一条规则。 */
export interface HookRule {
  /** 来源文件路径加该文件内序号 */
  id: string;
  event: HookEvent;
  source: HookSource;
  sourcePath: string;
  conditions?: HookCondition[];
  match?: HookMatch;
  /** 仅 pre_tool。非空表示命中后拦截，并作为工具结果 */
  denyMessage?: string;
  action: HookAction;
  once: boolean;
  /** 对应声明里的 async。拒绝或注入提示词时不能为 true */
  background: boolean;
  timeoutMs: number;
}

export const HOOK_DEFAULT_TIMEOUT_MS = 30_000;

export interface HookDispatchInput {
  event: HookEvent;
  sessionId: string;
  tool?: string;
  /** 权限参数提取得到的命令文本或路径。没有时条件不算命中 */
  subject?: string;
}

export interface HookDispatchResult {
  blocked: boolean;
  denyMessage?: string;
}

/** 启动校验失败。文案同时包含文件路径和原因。 */
export class HookFatalError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`${path}：${reason}`);
    this.name = "HookFatalError";
    this.path = path;
    this.reason = reason;
  }
}
