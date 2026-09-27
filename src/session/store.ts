import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, Session, SessionSummary } from "./types.js";
import { generateSessionId } from "./id.js";
import {
  appendLine,
  readSessionFile,
  repairToolPairing,
  rewriteAll,
  scanSummary,
} from "./jsonl.js";

export class SessionStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  list(): SessionSummary[] {
    if (!fs.existsSync(this.dir)) return [];
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".jsonl"));
    const summaries: SessionSummary[] = [];
    for (const file of files) {
      const s = scanSummary(path.join(this.dir, file));
      if (s) summaries.push(s);
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  create(title = "新会话"): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: generateSessionId(),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    rewriteAll(this.filePath(session.id), session);
    return session;
  }

  /**
   * 原样读取会话，不做 tool 配对修复。
   * append / 循环中途必须用这个，避免误删尚未写完结果的 assistant。
   */
  get(id: string): Session | null {
    const read = readSessionFile(this.filePath(id));
    return read?.session ?? null;
  }

  /**
   * 打开会话时调用：截掉未完成的工具尾部，并丢掉孤立 tool 消息。
   * 有改动则写回磁盘。
   */
  open(id: string): Session | null {
    const read = readSessionFile(this.filePath(id));
    if (!read) return null;
    const { messages, repaired } = repairToolPairing(read.session.messages);
    const session: Session = {
      ...read.session,
      messages,
      updatedAt: repaired ? new Date().toISOString() : read.session.updatedAt,
    };
    if (repaired) {
      rewriteAll(this.filePath(id), session);
    }
    return session;
  }

  appendMessage(sessionId: string, message: ChatMessage): void {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    session.messages.push(message);
    session.updatedAt = new Date().toISOString();

    let titleChanged = false;
    if (
      message.role === "user" &&
      session.messages.filter((m) => m.role === "user").length === 1
    ) {
      session.title = truncateTitle(message.content);
      titleChanged = true;
    }

    if (titleChanged) {
      rewriteAll(this.filePath(sessionId), session);
    } else {
      appendLine(this.filePath(sessionId), {
        type: "message",
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        ...(message.thinkingSummary
          ? { thinkingSummary: message.thinkingSummary }
          : {}),
        ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
        ...(message.isError !== undefined ? { isError: message.isError } : {}),
      });
    }
  }

  replaceMessages(sessionId: string, messages: ChatMessage[]): void {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    session.messages = messages;
    session.updatedAt = new Date().toISOString();
    rewriteAll(this.filePath(sessionId), session);
  }

  toolResultDir(sessionId: string): string {
    return path.join(this.dir, sessionId, "tool-results");
  }

  writeToolResult(sessionId: string, resultId: string, content: string): string {
    const dir = this.toolResultDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${resultId}.txt`);
    fs.writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  updateTitle(sessionId: string, title: string): void {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    session.title = title;
    session.updatedAt = new Date().toISOString();
    rewriteAll(this.filePath(sessionId), session);
  }

  /** 会话 JSONL 路径 */
  pathFor(id: string): string {
    return this.filePath(id);
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }
}

function truncateTitle(text: string, max = 40): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t || "新会话";
  return `${t.slice(0, max)}…`;
}
