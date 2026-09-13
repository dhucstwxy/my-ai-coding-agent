export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinkingSummary?: string;
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
}
