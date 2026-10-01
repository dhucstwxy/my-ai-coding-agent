import type { PermissionMode } from "../permission/types.js";
import type { ChatMessage } from "../session/types.js";
import type { ToolDefinition } from "../tools/types.js";

export type AgentScope = "project" | "user" | "builtin";

export type AgentKind = "defined" | "fork";

export type SubAgentStatus = "running" | "completed" | "failed" | "cancelled";

export type SubAgentNotify = "parent" | "log";

/** 读取并校验通过后的一个角色。 */
export interface AgentRecord {
  name: string;
  description?: string;
  /** 省略表示不收窄。空数组表示写了白名单但一条都没有 */
  tools?: string[];
  /** 省略或空数组表示不额外去掉 */
  disallowedTools?: string[];
  model?: string;
  /** 省略则用主对话的轮次上限。写了则是正整数 */
  maxTurns?: number;
  permission?: PermissionMode;
  /** 仅支持字面量 worktree；省略表示与主区共用工作区 */
  isolation?: "worktree";
  body: string;
  scope: AgentScope;
  path: string;
}

export interface AgentToolInput {
  type: AgentKind;
  task: string;
  name?: string;
  background?: boolean;
}

/** 父循环最近一次真正发出的模型请求。 */
export interface RequestSnapshot {
  system: string;
  tools: ToolDefinition[];
  messages: ChatMessage[];
}

export interface SubAgentUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 进程内的一份前台或后台任务。不写盘。 */
export interface SubAgentTask {
  id: string;
  parentSessionId: string;
  childSessionId: string;
  kind: AgentKind;
  roleName?: string;
  status: SubAgentStatus;
  background: boolean;
  notify: SubAgentNotify;
  finalText?: string;
  usage: SubAgentUsage;
  /** 前台实际运行毫秒。权限确认期间不增加 */
  runningMs: number;
  /** isolation: worktree 时由系统生成的逻辑名 */
  worktreeName?: string;
  /** isolation: worktree 时的隔离目录绝对路径 */
  worktreePath?: string;
}

export interface AgentWarning {
  path: string;
  reason: string;
}

/** 重新读取失败。文案含角色名；未知工具时再含工具名。 */
export class AgentFatalError extends Error {
  readonly roleName: string;
  readonly tool?: string;
  readonly reason: string;

  constructor(roleName: string, reason: string, tool?: string) {
    const message = tool
      ? `角色「${roleName}」：${reason}（工具 ${tool}）`
      : `角色「${roleName}」：${reason}`;
    super(message);
    this.name = "AgentFatalError";
    this.roleName = roleName;
    this.reason = reason;
    if (tool) this.tool = tool;
  }
}
