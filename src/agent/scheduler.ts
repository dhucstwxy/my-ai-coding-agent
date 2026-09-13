import type { StreamEvent } from "../provider/types.js";
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

/**
 * 只读并发，副作用串行；未知工具不执行，返回结构化失败。
 */
export async function* executeToolBatch(
  calls: CollectedToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
  cancel: CancelToken,
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

  // 未知：立即产出失败结果事件
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

  // 只读并发
  if (readonlyCalls.length > 0 && !cancel.isCancelled) {
    for (const call of readonlyCalls) {
      yield {
        type: "tool_execution_start",
        id: call.id,
        name: call.name,
        argsSummary: summarizeArgs(call.arguments),
      };
    }

    const settled = await Promise.all(
      readonlyCalls.map(async (call) => {
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
      results.push(item);
    }
  }

  // 副作用串行
  for (const call of sideEffectCalls) {
    if (cancel.isCancelled) break;
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
    results.push({ call, result, unknown: false });
  }

  return {
    unknownCount: unknownCalls.length,
    knownCount: readonlyCalls.length + sideEffectCalls.length,
    results,
  };
}

async function* emitExecution(
  call: CollectedToolCall,
  result: ToolResult,
): AsyncGenerator<StreamEvent> {
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
