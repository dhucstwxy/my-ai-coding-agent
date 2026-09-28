import type { HookEngine } from "../hooks/engine.js";
import type { PermissionGate } from "../permission/gate.js";
import { permissionSubject } from "../permission/subject.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import type { CancelToken } from "./cancel.js";
import type { AgentEvent, CollectedToolCall } from "./types.js";

const SUMMARY_MAX = 200;

export interface SchedulerResult {
  /** 本批是否全部为未知工具 */
  unknownCount: number;
  /** 本批是否含已知工具 */
  knownCount: number;
  results: Array<{
    call: CollectedToolCall;
    result: ToolResult;
    unknown: boolean;
  }>;
}

/** 可选。未传时工具调度与现在相同，不发 Hook。 */
export interface SchedulerHooks {
  engine: HookEngine;
  sessionId: string;
}

/**
 * 可选。未传时与现在相同。
 * 传入后，委派工具以及不在名单里的调用直接失败，不发 Hook，也不过闸门。
 */
export interface ToolBatchPolicy {
  allowNames?: ReadonlySet<string>;
  /** false 时闸门把询问改成拒绝 */
  interactive?: boolean;
}

/**
 * 只读并发，副作用串行；未知工具不执行，返回结构化失败。
 * 已知工具先过 pre_tool，未拦截时再过权限闸门。
 */
export async function* executeToolBatch(
  calls: CollectedToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
  cancel: CancelToken,
  gate: PermissionGate,
  sessionId: string,
  hooks?: SchedulerHooks,
  policy?: ToolBatchPolicy,
): AsyncGenerator<AgentEvent, SchedulerResult> {
  const readonlyCalls: CollectedToolCall[] = [];
  const sideEffectCalls: CollectedToolCall[] = [];
  const unknownCalls: CollectedToolCall[] = [];

  for (const call of calls) {
    const tool = registry.get(call.name);
    if (!tool) {
      unknownCalls.push(call);
    } else if (tool.sideEffect) {
      sideEffectCalls.push(call);
    } else {
      readonlyCalls.push(call);
    }
  }

  const results: SchedulerResult["results"] = [];

  for (const call of unknownCalls) {
    if (cancel.isCancelled) break;
    const result: ToolResult = {
      ok: false,
      content: `未知工具：${call.name}`,
      errorCode: "unknown_tool",
    };
    yield* emitExecution(call, result);
    results.push({ call, result, unknown: true });
  }

  const allowedReadonly: CollectedToolCall[] = [];
  if (readonlyCalls.length > 0 && !cancel.isCancelled) {
    for (const call of readonlyCalls) {
      if (cancel.isCancelled) break;
      const guarded = yield* guardCall(call, gate, sessionId, cancel, true, hooks, policy);
      if (guarded) {
        results.push({ call, result: guarded, unknown: false });
        continue;
      }
      allowedReadonly.push(call);
    }
  }

  if (allowedReadonly.length > 0 && !cancel.isCancelled) {
    for (const call of allowedReadonly) {
      yield {
        type: "tool_execution_start",
        id: call.id,
        name: call.name,
        argsSummary: summarizeArgs(call.arguments),
      };
    }

    const settled = await Promise.all(
      allowedReadonly.map(async (call) => {
        const result = await runOne(call, registry, ctx);
        return { call, result, unknown: false as const };
      }),
    );

    for (const item of settled) {
      yield {
        type: "tool_execution_end",
        id: item.call.id,
        name: item.call.name,
        ok: item.result.ok,
        resultSummary: summarizeResult(item.result.content),
      };
      await dispatchPostTool(hooks, item.call);
      results.push(item);
    }
  }

  for (const call of sideEffectCalls) {
    if (cancel.isCancelled) break;
    const guarded = yield* guardCall(call, gate, sessionId, cancel, false, hooks, policy);
    if (guarded) {
      results.push({ call, result: guarded, unknown: false });
      continue;
    }
    yield {
      type: "tool_execution_start",
      id: call.id,
      name: call.name,
      argsSummary: summarizeArgs(call.arguments),
    };
    const result = await runOne(call, registry, ctx);
    yield {
      type: "tool_execution_end",
      id: call.id,
      name: call.name,
      ok: result.ok,
      resultSummary: summarizeResult(result.content),
    };
    await dispatchPostTool(hooks, call);
    results.push({ call, result, unknown: false });
  }

  return {
    unknownCount: unknownCalls.length,
    knownCount: readonlyCalls.length + sideEffectCalls.length,
    results,
  };
}

/**
 * 解析失败或权限拒绝时返回失败结果，调用方不得再执行工具。
 * 通过时返回 null。
 */
async function* guardCall(
  call: CollectedToolCall,
  gate: PermissionGate,
  sessionId: string,
  cancel: CancelToken,
  readOnly: boolean,
  hooks?: SchedulerHooks,
  policy?: ToolBatchPolicy,
): AsyncGenerator<AgentEvent, ToolResult | null> {
  if (call.parseError) {
    const result: ToolResult = {
      ok: false,
      content: call.parseError,
      errorCode: "parse_error",
    };
    yield* emitExecution(call, result);
    return result;
  }

  if (policy?.allowNames) {
    if (call.name === "agent" || !policy.allowNames.has(call.name)) {
      const result: ToolResult = {
        ok: false,
        content: `当前子任务不能调用：${call.name}`,
        errorCode: "tool_not_allowed",
      };
      yield* emitExecution(call, result);
      return result;
    }
  }

  if (hooks) {
    const subject = permissionSubject(call.name, call.arguments);
    if (subject.ok) {
      const hooked = await hooks.engine.dispatch({
        event: "pre_tool",
        sessionId: hooks.sessionId,
        tool: call.name,
        subject: subject.subject,
      });
      if (hooked.blocked) {
        const result: ToolResult = {
          ok: false,
          content: hooked.denyMessage ?? "Hook 已拦截该工具",
          errorCode: "hook_blocked",
        };
        yield* emitExecution(call, result);
        return result;
      }
    }
  }

  const decision = await gate.check({
    sessionId,
    call,
    signal: cancel,
    readOnly,
    ...(policy?.interactive === false ? { interactive: false } : {}),
  });
  if (decision.effect === "deny") {
    const result: ToolResult = {
      ok: false,
      content: decision.message,
      errorCode: decision.reason,
    };
    yield {
      type: "permission_denied",
      id: call.id,
      tool: call.name,
      reason: decision.reason,
      message: decision.message,
    };
    yield* emitExecution(call, result);
    return result;
  }
  return null;
}

async function* emitExecution(
  call: CollectedToolCall,
  result: ToolResult,
): AsyncGenerator<AgentEvent> {
  yield {
    type: "tool_execution_start",
    id: call.id,
    name: call.name,
    argsSummary: summarizeArgs(call.arguments),
  };
  yield {
    type: "tool_execution_end",
    id: call.id,
    name: call.name,
    ok: result.ok,
    resultSummary: summarizeResult(result.content),
  };
}

async function dispatchPostTool(
  hooks: SchedulerHooks | undefined,
  call: CollectedToolCall,
): Promise<void> {
  if (!hooks) return;
  const subject = permissionSubject(call.name, call.arguments);
  try {
    await hooks.engine.dispatch({
      event: "post_tool",
      sessionId: hooks.sessionId,
      tool: call.name,
      ...(subject.ok ? { subject: subject.subject } : {}),
    });
  } catch (err) {
    console.error(
      `[hook] post_tool 失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runOne(
  call: CollectedToolCall,
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (call.parseError) {
    return {
      ok: false,
      content: call.parseError,
      errorCode: "parse_error",
    };
  }
  return registry.execute(call.name, call.arguments, ctx);
}

function summarizeArgs(args: Record<string, unknown> | string): string {
  const raw = typeof args === "string" ? args : JSON.stringify(args);
  if (raw.length <= SUMMARY_MAX) return raw;
  return `${raw.slice(0, SUMMARY_MAX)}…`;
}

function summarizeResult(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= SUMMARY_MAX) return compact;
  return `${compact.slice(0, SUMMARY_MAX)}…`;
}
