/** 本会话精确放行。键是会话、工具、参数全等，进程退出即失效。 */
export class SessionGrantStore {
  private readonly grants = new Set<string>();

  grant(sessionId: string, tool: string, subject: string): void {
    this.grants.add(key(sessionId, tool, subject));
  }

  has(sessionId: string, tool: string, subject: string): boolean {
    return this.grants.has(key(sessionId, tool, subject));
  }
}

function key(sessionId: string, tool: string, subject: string): string {
  return `${sessionId}\0${tool}\0${subject}`;
}
