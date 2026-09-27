/** 导出给模型 API 的工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema（object） */
  inputSchema: Record<string, unknown>;
}

/** 工具执行的结构化结果 */
export interface ToolResult {
  ok: boolean;
  /** 给模型看的文本（失败时为错误说明；过大时已截断） */
  content: string;
  errorCode?: string;
}

/** 单次执行上下文 */
export interface ToolContext {
  workspaceRoot: string;
  timeoutMs: number;
  /** 当前主会话，供 load_skill 写入激活表 */
  sessionId?: string;
}

/** 统一工具接口 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** true = 有副作用，调度时必须串行 */
  sideEffect: boolean;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
