import { ruleMatches } from "../permission/match.js";
import { runAction } from "./actions.js";
import type { HookSessionState } from "./state.js";
import type {
  HookCondition,
  HookDispatchInput,
  HookDispatchResult,
  HookRule,
} from "./types.js";

function defaultLog(line: string): void {
  console.error(line);
}

/**
 * 按加载顺序执行命中的规则。动作失败只记日志。
 * 只有 pre_tool 可能返回 blocked。
 */
export class HookEngine {
  constructor(
    private readonly ruleList: HookRule[],
    private readonly state: HookSessionState,
    private readonly workspaceRoot: string,
    private readonly log: (line: string) => void = defaultLog,
  ) {}

  rules(): HookRule[] {
    return this.ruleList;
  }

  async dispatch(input: HookDispatchInput): Promise<HookDispatchResult> {
    const denies: string[] = [];
    for (const rule of this.ruleList) {
      if (rule.event !== input.event) continue;
      if (rule.once && this.state.hasOnce(input.sessionId, rule.id)) continue;
      if (!ruleMatchesInput(rule, input)) continue;
      if (rule.once) this.state.markOnce(input.sessionId, rule.id);
      try {
        await runAction(rule, input.sessionId, this.state, this.log, this.workspaceRoot);
      } catch (err) {
        this.log(
          `[hook] ${rule.id} 动作失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (input.event === "pre_tool" && rule.denyMessage) {
        denies.push(rule.denyMessage);
      }
    }
    if (input.event === "pre_tool" && denies.length > 0) {
      return { blocked: true, denyMessage: denies.join("\n") };
    }
    return { blocked: false };
  }
}

function ruleMatchesInput(rule: HookRule, input: HookDispatchInput): boolean {
  if (!rule.conditions || rule.conditions.length === 0) return true;
  if (input.event !== "pre_tool" && input.event !== "post_tool") return true;
  if (!input.tool || input.subject === undefined) return false;
  const hit = (condition: HookCondition) =>
    condition.tool === input.tool && ruleMatches(condition.pattern, input.subject ?? "");
  if (rule.match === "any") return rule.conditions.some(hit);
  return rule.conditions.every(hit);
}
