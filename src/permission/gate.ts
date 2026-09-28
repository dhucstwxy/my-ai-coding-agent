import type { CancelToken } from "../agent/cancel.js";
import { resolveInWorkspace } from "../tools/workspace.js";
import { matchBlacklist } from "./blacklist.js";
import { ruleMatches } from "./match.js";
import type { PermissionModeStore } from "./mode-store.js";
import { appendLocalAllow } from "./persist.js";
import type { SessionGrantStore } from "./session-grants.js";
import { permissionSubject } from "./subject.js";
import type {
  PermissionDecision,
  PermissionEffect,
  PermissionPrompter,
  PermissionRule,
} from "./types.js";

const PATH_TOOLS = new Set(["read_file", "write_file", "edit_file", "grep_search"]);
const SUMMARY_MAX = 200;

export interface PermissionCheckInput {
  sessionId: string;
  call: {
    id: string;
    name: string;
    arguments: Record<string, unknown> | string;
  };
  signal: CancelToken;
  /**
   * 本次调用是否为只读（无副作用）。
   * 默认档下若没有规则命中，只读调用直接放行而不询问；严格档与放行档不受影响。
   */
  readOnly?: boolean;
  /**
   * 省略或 true 时，需要询问就弹出确认。
   * false 时把询问改成拒绝，不再调用确认器。后台子任务使用。
   */
  interactive?: boolean;
}

export interface PermissionGateDeps {
  rules: PermissionRule[];
  modeStore: PermissionModeStore;
  grants: SessionGrantStore;
  workspaceRoot: string;
  prompter?: PermissionPrompter;
}

/**
 * 工具执行前的统一闸门。顺序：黑名单、沙箱、合并规则、档位、必要时询问。
 */
export class PermissionGate {
  private readonly rules: PermissionRule[];
  private prompter: PermissionPrompter;
  private askObserver: { onStart(): void; onEnd(): void } | null = null;

  constructor(private readonly deps: PermissionGateDeps) {
    this.rules = [...deps.rules];
    this.prompter = deps.prompter ?? {
      async ask() {
        return "deny";
      },
    };
  }

  setPrompter(prompter: PermissionPrompter): void {
    this.prompter = prompter;
  }

  /** 前台子任务用它暂停计时。权限确认打开期间不计运行时间。 */
  setAskObserver(observer: { onStart(): void; onEnd(): void } | null): void {
    this.askObserver = observer;
  }

  async check(input: PermissionCheckInput): Promise<PermissionDecision> {
    const subject = permissionSubject(input.call.name, input.call.arguments);
    if (!subject.ok) {
      return deny("rule", `已拒绝：${subject.message}`);
    }

    if (input.call.name === "run_command") {
      const blocked = matchBlacklist(subject.subject);
      if (blocked.matched) {
        return deny(
          "blacklist",
          `已拒绝：命令命中危险命令黑名单（${blocked.message}）`,
        );
      }
    }

    const sandboxed = checkSandbox(
      input.call.name,
      subject.subject,
      this.deps.workspaceRoot,
    );
    if (sandboxed) return sandboxed;

    const matched: PermissionEffect[] = [];
    for (const rule of this.rules) {
      if (rule.tool !== input.call.name) continue;
      if (!ruleMatches(rule.pattern, subject.subject)) continue;
      matched.push(rule.effect);
    }
    if (this.deps.grants.has(input.sessionId, input.call.name, subject.subject)) {
      matched.push("allow");
    }

    const winner = pickEffect(matched);
    if (winner === "deny") {
      return deny("rule", "已拒绝：规则拒绝该调用");
    }
    if (winner === "allow") {
      return allow("已允许：规则放行");
    }
    if (winner === "ask") {
      return this.askUser(input, subject.subject);
    }

    const mode = this.deps.modeStore.get(input.sessionId);
    if (mode === "strict") {
      return deny("mode", "已拒绝：当前为严格档，且没有放行规则");
    }
    if (mode === "allow") {
      return allow("已允许：当前为放行档");
    }
    // 默认档：只读工具不改变工作区，直接放行，避免每次读取都要用户确认
    if (input.readOnly) {
      return allow("已允许：默认档下只读工具直接放行");
    }
    return this.askUser(input, subject.subject);
  }

  private async askUser(
    input: PermissionCheckInput,
    subject: string,
  ): Promise<PermissionDecision> {
    if (input.interactive === false) {
      return deny("mode", "已拒绝：后台任务不能询问用户，本次调用被拒绝");
    }
    if (input.signal.isCancelled) {
      return deny("user", "已拒绝：用户拒绝本次调用");
    }

    this.askObserver?.onStart();
    let choice;
    try {
      choice = await this.prompter.ask(
        {
          tool: input.call.name,
          subject,
          argsSummary: summarizeArgs(input.call.arguments),
        },
        input.signal,
      );
    } finally {
      this.askObserver?.onEnd();
    }

    if (input.signal.isCancelled || choice === "deny") {
      return deny("user", "已拒绝：用户拒绝本次调用");
    }
    if (choice === "once") {
      return allow("已允许：仅本次放行");
    }
    if (choice === "session") {
      this.deps.grants.grant(input.sessionId, input.call.name, subject);
      return allow("已允许：本会话放行");
    }

    const written = appendLocalAllow(this.deps.workspaceRoot, input.call.name, subject);
    if (!written.ok) {
      return deny(
        "write_failed",
        `已拒绝：永久放行写入失败，本次不执行。${written.message}`,
      );
    }
    this.rules.push({
      tool: input.call.name,
      pattern: subject,
      effect: "allow",
      source: "local",
    });
    return allow("已允许：已写入本地规则");
  }
}

function checkSandbox(
  tool: string,
  subject: string,
  workspaceRoot: string,
): PermissionDecision | null {
  if (tool === "glob_files" && subject.includes("..")) {
    return deny("sandbox", "已拒绝：查找模式含 ..，不能越出项目目录");
  }
  if (!PATH_TOOLS.has(tool)) return null;
  const resolved = resolveInWorkspace(workspaceRoot, subject);
  if (!resolved.ok) {
    return deny("sandbox", `已拒绝：${resolved.error}`);
  }
  return null;
}

function pickEffect(effects: PermissionEffect[]): PermissionEffect | null {
  if (effects.length === 0) return null;
  if (effects.includes("deny")) return "deny";
  if (effects.includes("ask")) return "ask";
  if (effects.includes("allow")) return "allow";
  return null;
}

function deny(reason: PermissionDecision["reason"], message: string): PermissionDecision {
  return { effect: "deny", reason, message };
}

function allow(message: string): PermissionDecision {
  return { effect: "allow", reason: "rule", message };
}

function summarizeArgs(args: Record<string, unknown> | string): string {
  const raw = typeof args === "string" ? args : JSON.stringify(args);
  if (raw.length <= SUMMARY_MAX) return raw;
  return `${raw.slice(0, SUMMARY_MAX)}…`;
}
