/**
 * 进程内按会话保存注入文本和只跑一次标记。不写盘。
 */
export class HookSessionState {
  private readonly promptsBySession = new Map<string, string[]>();
  private readonly onceBySession = new Map<string, Set<string>>();

  addPrompt(sessionId: string, text: string): void {
    const list = this.promptsBySession.get(sessionId) ?? [];
    list.push(text);
    this.promptsBySession.set(sessionId, list);
  }

  /** 多条注入用空行拼接。没有注入时返回空串。 */
  prompts(sessionId: string): string {
    const list = this.promptsBySession.get(sessionId);
    if (!list || list.length === 0) return "";
    return list.join("\n\n");
  }

  markOnce(sessionId: string, ruleId: string): void {
    const set = this.onceBySession.get(sessionId) ?? new Set<string>();
    set.add(ruleId);
    this.onceBySession.set(sessionId, set);
  }

  hasOnce(sessionId: string, ruleId: string): boolean {
    return this.onceBySession.get(sessionId)?.has(ruleId) ?? false;
  }

  /** 只清该会话的注入和只跑一次标记。 */
  clear(sessionId: string): void {
    this.promptsBySession.delete(sessionId);
    this.onceBySession.delete(sessionId);
  }
}
