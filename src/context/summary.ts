import type { ChatMessage } from "../session/types.js";

export interface SummaryPromptInput {
  olderMessages: ChatMessage[];
  userNote?: string;
}

export interface SummaryPrompt {
  system: string;
  user: string;
}

const SECTION_TITLES = [
  "会话意图与目标",
  "关键决策与约束",
  "已完成工作",
  "当前状态与待办",
  "相关文件与路径",
] as const;

export function buildSummaryPrompt(input: SummaryPromptInput): SummaryPrompt {
  const system = [
    "你是会话历史压缩助手。你的唯一任务是根据给定的较早对话消息，生成结构化摘要。",
    "严禁调用任何工具；不要输出工具调用、函数调用或 XML/JSON 工具格式。",
    "请先写一段简短的「分析草稿」（梳理要点），然后输出正式摘要。",
    "正式摘要必须以标题「正式摘要」开头，或用一行 --- 与草稿分隔；草稿之后调用方会丢弃，只保留正式摘要。",
    "正式摘要必须包含以下五个固定部分（使用相同标题）：",
    ...SECTION_TITLES.map((t, i) => `${i + 1}. ${t}`),
    "用简洁中文撰写；保留关键路径、接口名与决策，不要臆造未出现的代码细节。",
  ].join("\n");

  const lines: string[] = ["以下是需要摘要的较早对话消息："];
  for (const m of input.olderMessages) {
    lines.push("---");
    lines.push(`[${m.role}]`);
    lines.push(m.content);
    if (m.toolName) lines.push(`(tool: ${m.toolName})`);
  }
  if (input.userNote?.trim()) {
    lines.push("---");
    lines.push("用户备注（请在摘要中优先保留相关细节）：");
    lines.push(input.userNote.trim());
  }
  lines.push("---");
  lines.push("请先写分析草稿，再输出正式摘要（含上述五个标题）。");

  return { system, user: lines.join("\n") };
}

/** 丢弃草稿，提取正式摘要正文 */
export function extractFormalSummary(rawText: string): string {
  const text = rawText.trim();
  if (!text) return "";

  const formalHeading = /(?:^|\n)\s*正式摘要\s*[:：]?\s*\n/i.exec(text);
  if (formalHeading && formalHeading.index !== undefined) {
    return text.slice(formalHeading.index + formalHeading[0].length).trim();
  }

  const sep = /\n---+\n/.exec(text);
  if (sep && sep.index !== undefined) {
    // 取最后一个 --- 之后（草稿在前、正文在后的常见格式）
    const parts = text.split(/\n---+\n/);
    if (parts.length >= 2) {
      return parts[parts.length - 1].trim();
    }
  }

  return text;
}

export { SECTION_TITLES };
