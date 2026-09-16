export const SYSTEM_REMINDER_TAG = "system-reminder";
export const DEFAULT_REINFORCE_EVERY = 5;

export type PromptSectionId =
  | "identity"
  | "constraints"
  | "task_mode"
  | "action"
  | "tools"
  | "tone"
  | "output"
  | "environment"
  | "custom_instructions"
  | "skills"
  | "memory";

export interface PromptSection {
  id: PromptSectionId;
  priority: number;
  title?: string;
  /** 空字符串表示本轮跳过该槽 */
  content: string;
}

export interface BuildPromptInput {
  workspaceRoot: string;
  now: Date;
  platform: string;
  customInstructions?: string;
  activeSkillsText?: string;
  memoryText?: string;
}

export interface BuildPromptResult {
  /** 仅固定七模块，字节级稳定 */
  stableSystem: string;
  /** stable + 环境 + 非空可选槽（调试用） */
  fullSystem: string;
  sections: PromptSection[];
}

export type ReminderKind =
  | "plan_full"
  | "plan_reinforce"
  | "plan_brief"
  | "environment"
  | "execute_brief";

export interface ReminderMessage {
  role: "user";
  content: string;
  kind: ReminderKind;
}

export interface EnvironmentInfo {
  workspaceRoot: string;
  timeLabel: string;
  platform: string;
}

export interface ReminderInput {
  mode: "plan" | "execute";
  iteration: number;
  reinforceEvery: number;
  environment: EnvironmentInfo;
}

/** 进入稳定 system 的固定模块（不含环境与可选槽） */
export const STABLE_SECTION_IDS: PromptSectionId[] = [
  "identity",
  "constraints",
  "task_mode",
  "action",
  "tools",
  "tone",
  "output",
];
