import type { CancelToken } from "../agent/cancel.js";

/** 会话权限档位。新会话为 default。 */
export type PermissionMode = "strict" | "default" | "allow";

/** 规则结果。询问在闸门内部解决，对外只留下允许或拒绝。 */
export type PermissionEffect = "allow" | "ask" | "deny";

/** 用户在确认时的四个选择。 */
export type PermissionChoice = "deny" | "once" | "session" | "permanent";

export type PermissionSource = "user" | "project" | "local" | "session";

export interface PermissionRule {
  tool: string;
  pattern: string;
  effect: PermissionEffect;
  source: PermissionSource;
}

export type PermissionDenyReason =
  | "blacklist"
  | "sandbox"
  | "rule"
  | "mode"
  | "user"
  | "write_failed";

export interface PermissionDecision {
  effect: "allow" | "deny";
  reason: PermissionDenyReason;
  message: string;
}

export interface RuleSet {
  rules: PermissionRule[];
  warnings: string[];
}

export interface PermissionPrompt {
  tool: string;
  /** 命令文本或路径，也就是将要记住的精确参数 */
  subject: string;
  argsSummary: string;
}

export interface PermissionPrompter {
  /**
   * 向界面要一个选择。任务已取消时必须返回 deny，不再等待。
   */
  ask(prompt: PermissionPrompt, signal: CancelToken): Promise<PermissionChoice>;
}
