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
  /** 已激活 Skill 的完整说明，放在环境提醒最前 */
  pinnedText?: string;
  /** 只有名字和一句话说明 */
  catalogText?: string;
  /** Hook 注入的提示词，位于 Skill 目录之后、环境信息之前 */
  hookPrompt?: string;
  /** 角色目录，位于 Hook 注入之后、工作区信息之前。空则不出现 */
  agentCatalog?: string;
  /** 活跃小组与 Coordinator 状态，位于环境信息之前 */
  teamStatus?: string;
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
