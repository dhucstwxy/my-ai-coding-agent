import type { ChatMessage } from "../session/types.js";
import type { SkillSession } from "./session.js";
import type { SkillRecord, SkillRun } from "./types.js";

export interface SkillRunDeps {
  session: SkillSession;
  /** 共享模式：把用户任务送进主循环，不再解析斜杠 */
  submitToAgent: (sessionId: string, task: string) => Promise<void>;
  /** 独立模式：只跑给定历史，返回最后一段助手正文 */
  runIsolated: (input: {
    sessionId: string;
    skill: SkillRecord;
    task: string;
    history: ChatMessage[];
  }) => Promise<string>;
  findModel: (model: string) => boolean;
  recentMessages: (sessionId: string, count: number) => ChatMessage[];
  appendSummary: (sessionId: string, text: string) => void;
}

export function skillTask(skill: SkillRecord, args: string): string {
  const trimmed = args.trim();
  if (trimmed) return trimmed;
  return `请按已激活的 ${skill.name} 说明执行。`;
}

const EMPTY_SUMMARY = "该 Skill 已结束且没有文本结果";

/** 先检查模型，再激活，然后按模式执行。返回独立模式的摘要；共享模式返回空串。 */
export async function runSkill(
  run: SkillRun,
  deps: SkillRunDeps,
): Promise<string> {
  if (run.skill.model && !deps.findModel(run.skill.model)) {
    throw new Error(`找不到模型：${run.skill.model}`);
  }

  deps.session.activate(run.sessionId, run.skill.name, run.args);
  const task = skillTask(run.skill, run.args);

  if (run.skill.mode === "isolated") {
    const history = deps.recentMessages(run.sessionId, run.skill.history);
    const summary = await deps.runIsolated({
      sessionId: run.sessionId,
      skill: run.skill,
      task,
      history,
    });
    const text = summary.trim() || EMPTY_SUMMARY;
    deps.appendSummary(run.sessionId, text);
    return text;
  }

  await deps.submitToAgent(run.sessionId, task);
  return "";
}
