import { SYSTEM_REMINDER_TAG } from "./types.js";
import type {
  ReminderInput,
  ReminderKind,
  ReminderMessage,
} from "./types.js";
import { DEFAULT_REINFORCE_EVERY } from "./types.js";

function wrapReminder(body: string): string {
  return `<${SYSTEM_REMINDER_TAG}>\n${body.trim()}\n</${SYSTEM_REMINDER_TAG}>`;
}

function environmentBody(input: ReminderInput): string {
  const e = input.environment;
  const base = [
    "当前运行环境（每轮可能变化，勿写入可缓存指令）：",
    `- 工作区根路径：${e.workspaceRoot}`,
    `- 当前时间：${e.timeLabel}`,
    `- 操作系统：${e.platform}`,
  ].join("\n");
  const parts: string[] = [];
  const pinned = input.pinnedText?.trim();
  const catalog = input.catalogText?.trim();
  const hookPrompt = input.hookPrompt?.trim();
  const agentCatalog = input.agentCatalog?.trim();
  if (pinned) parts.push(pinned);
  if (catalog) parts.push(catalog);
  if (hookPrompt) parts.push(hookPrompt);
  if (agentCatalog) parts.push(agentCatalog);
  parts.push(base);
  return parts.join("\n\n");
}

const PLAN_FULL = [
  "当前为计划模式。",
  "只允许只读工具：read_file、glob_files、grep_search。",
  "禁止写文件、改文件、执行命令。先调研再给出计划，等待用户 /do 后再改动工作区。",
].join("\n");

const PLAN_REINFORCE = [
  "再次提醒：仍处于计划模式，仅只读工具，不要写/改/执行命令。",
].join("\n");

const PLAN_BRIEF = "计划模式：仅只读工具。";

function planKind(iteration: number, every: number): ReminderKind {
  if (iteration === 1) return "plan_full";
  if (iteration > 1 && iteration % every === 1) return "plan_reinforce";
  return "plan_brief";
}

function planBody(kind: ReminderKind): string {
  if (kind === "plan_full") return PLAN_FULL;
  if (kind === "plan_reinforce") return PLAN_REINFORCE;
  return PLAN_BRIEF;
}

export function buildReminders(input: ReminderInput): ReminderMessage[] {
  const every =
    input.reinforceEvery > 0 ? input.reinforceEvery : DEFAULT_REINFORCE_EVERY;
  const envMsg: ReminderMessage = {
    role: "user",
    kind: "environment",
    content: wrapReminder(environmentBody(input)),
  };

  if (input.mode === "execute") {
    return [envMsg];
  }

  const kind = planKind(input.iteration, every);
  return [
    {
      role: "user",
      kind,
      content: wrapReminder(planBody(kind)),
    },
    envMsg,
  ];
}

export class ReminderBuilder {
  build(input: ReminderInput): ReminderMessage[] {
    return buildReminders(input);
  }
}
