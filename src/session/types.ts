export interface ToolCallRecord {
  id: string;
  name: string;
  /** 解析成功为对象；解析失败可保留原始字符串 */
  arguments: Record<string, unknown> | string;
  /** 非第一个工具调用时为 true */
  ignored?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  thinkingSummary?: string;
  toolCalls?: ToolCallRecord[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  createdAt: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount?: number;
}
