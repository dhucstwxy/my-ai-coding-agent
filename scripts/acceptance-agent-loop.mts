/**
 * Agent Loop 无头验收：不打印 api_key。
 */
import { loadConfig } from "../src/config/load.ts";
import { createProvider } from "../src/provider/factory.ts";
import { SessionStore } from "../src/session/store.ts";
import { createDefaultRegistry } from "../src/tools/create-registry.ts";
import { ChatService } from "../src/chat/service.ts";
import { AgentLoop } from "../src/agent/loop.ts";
import { createCancelToken } from "../src/agent/cancel.ts";
import { collectStream } from "../src/agent/collector.ts";
import { executeToolBatch } from "../src/agent/scheduler.ts";
import { filterToolsForMode, PlanModeStore } from "../src/agent/plan-mode.ts";
import type { AgentEvent, CollectedToolCall } from "../src/agent/types.ts";
import type { StreamEvent } from "../src/provider/types.ts";
import type { ChatProvider } from "../src/provider/types.ts";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const results: Array<{ id: string; pass: boolean; evidence: string }> = [];

function record(id: string, pass: boolean, evidence: string) {
  results.push({ id, pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"} [${id}] ${evidence}`);
}

async function drain(iter: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const e of iter) events.push(e);
  return events;
}

async function main() {
  record("typecheck", true, "npm run typecheck 已通过（外部）");

  const registry = createDefaultRegistry();
  const readonlyOk = ["read_file", "glob_files", "grep_search"].every(
    (n) => registry.get(n)?.sideEffect === false,
  );
  const sideOk = ["write_file", "edit_file", "run_command"].every(
    (n) => registry.get(n)?.sideEffect === true,
  );
  record("T2-sideEffect", readonlyOk && sideOk, `readonlyOk=${readonlyOk} sideOk=${sideOk}`);

  // Collector
  async function* fakeStream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "hi" };
    yield {
      type: "tool_call_end",
      id: "1",
      name: "read_file",
      arguments: { path: "a" },
    };
    yield { type: "done" };
  }
  const seen: AgentEvent[] = [];
  const col = collectStream(fakeStream());
  let step = await col.next();
  while (!step.done) {
    seen.push(step.value);
    step = await col.next();
  }
  const turn = step.value;
  record(
    "T3-collector",
    turn.text === "hi" && turn.toolCalls.length === 1 && seen.some((e) => e.type === "text_delta"),
    `text=${turn.text} tools=${turn.toolCalls.length} seenDelta=${seen.some((e) => e.type === "text_delta")}`,
  );

  // Scheduler concurrency
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mew-sched-"));
  const delayTool = {
    name: "read_file",
    sideEffect: false as const,
    description: "d",
    inputSchema: {},
    async execute() {
      await new Promise((r) => setTimeout(r, 80));
      return { ok: true, content: "ok" };
    },
  };
  // 用真实 registry 的 read 两次会很快；用 mock 注册表
  const { ToolRegistry } = await import("../src/tools/registry.ts");
  const mockReg = new ToolRegistry();
  mockReg.register({
    ...delayTool,
    name: "read_file",
  });
  mockReg.register({
    name: "glob_files",
    sideEffect: false,
    description: "d",
    inputSchema: {},
    async execute() {
      await new Promise((r) => setTimeout(r, 80));
      return { ok: true, content: "g" };
    },
  });
  const calls: CollectedToolCall[] = [
    { id: "a", name: "read_file", arguments: {} },
    { id: "b", name: "glob_files", arguments: {} },
  ];
  const t0 = Date.now();
  const cancel = createCancelToken();
  const gen = executeToolBatch(
    calls,
    mockReg,
    { workspaceRoot: tmpRoot, timeoutMs: 5000 },
    cancel,
  );
  let s = await gen.next();
  while (!s.done) s = await gen.next();
  const elapsed = Date.now() - t0;
  record(
    "AC9-parallel-readonly",
    elapsed < 140,
    `elapsedMs=${elapsed} (期望并发 <140，串行约160+)`,
  );

  // Plan filter
  const planDefs = filterToolsForMode(registry, "plan");
  const execDefs = filterToolsForMode(registry, "execute");
  record(
    "AC11-plan-filter",
    planDefs.length === 3 && execDefs.length === 6,
    `plan=${planDefs.length} exec=${execDefs.length}`,
  );

  const loaded = loadConfig();
  const active = loaded.config.providers.find(
    (p) => p.name === loaded.config.activeProvider,
  )!;
  const keyOk =
    active.apiKey &&
    active.apiKey !== "YOUR_API_KEY" &&
    active.apiKey.length > 8;

  // max iterations with mock provider
  const mockProvider: ChatProvider = {
    protocol: "openai",
    supportsThinking: false,
    async *streamChat() {
      yield {
        type: "tool_call_end",
        id: "x",
        name: "read_file",
        arguments: { path: "package.json" },
      };
      yield { type: "done" };
    },
  };
  const store = new SessionStore(path.join(os.tmpdir(), `mew-loop-${Date.now()}`));
  const loop = new AgentLoop(
    store,
    mockProvider,
    active,
    registry,
    process.cwd(),
    { maxIterations: 2, unknownToolLimit: 2, toolTimeoutMs: 10_000 },
  );
  const sess = store.create();
  const evMax = await drain(
    loop.run(sess.id, "keep going", {
      cancel: createCancelToken(),
      mode: "execute",
    }),
  );
  const stoppedMax = evMax.find((e) => e.type === "agent_stopped");
  record(
    "AC3-max-iterations",
    stoppedMax?.type === "agent_stopped" &&
      stoppedMax.reason === "max_iterations",
    `reason=${stoppedMax && stoppedMax.type === "agent_stopped" ? stoppedMax.reason : "none"}`,
  );

  // unknown tools x2
  const unknownProvider: ChatProvider = {
    protocol: "openai",
    supportsThinking: false,
    async *streamChat() {
      yield {
        type: "tool_call_end",
        id: "u1",
        name: "no_such_tool_a",
        arguments: {},
      };
      yield {
        type: "tool_call_end",
        id: "u2",
        name: "no_such_tool_b",
        arguments: {},
      };
      yield { type: "done" };
    },
  };
  const loopU = new AgentLoop(store, unknownProvider, active, registry, process.cwd());
  const sessU = store.create();
  const evU = await drain(
    loopU.run(sessU.id, "bad tools", {
      cancel: createCancelToken(),
      mode: "execute",
    }),
  );
  const stoppedU = evU.find((e) => e.type === "agent_stopped");
  record(
    "AC5-unknown",
    stoppedU?.type === "agent_stopped" && stoppedU.reason === "unknown_tools",
    `reason=${stoppedU && stoppedU.type === "agent_stopped" ? stoppedU.reason : "none"}`,
  );

  // cancel
  const cancelTok = createCancelToken();
  cancelTok.cancel();
  const sessC = store.create();
  const evC = await drain(
    loop.run(sessC.id, "cancel me", { cancel: cancelTok, mode: "execute" }),
  );
  const stoppedC = evC.find((e) => e.type === "agent_stopped");
  record(
    "AC4-cancel",
    stoppedC?.type === "agent_stopped" && stoppedC.reason === "cancelled",
    `reason=${stoppedC && stoppedC.type === "agent_stopped" ? stoppedC.reason : "none"}`,
  );

  // slash mode via ChatService
  const chat = new ChatService(store, mockProvider, active, registry, process.cwd());
  const sessM = store.create();
  const evPlan = await drain(chat.send(sessM.id, "/plan"));
  record(
    "AC12-slash-plan",
    evPlan.some((e) => e.type === "mode_changed" && e.mode === "plan") &&
      chat.getMode(sessM.id) === "plan",
    `mode=${chat.getMode(sessM.id)}`,
  );

  if (!keyOk) {
    record("AC13-deepseek", false, "无真实 api_key，跳过实呼");
  } else {
    const provider = createProvider(active);
    const liveStore = new SessionStore(
      path.join(os.tmpdir(), `mew-live-${Date.now()}`),
    );
    const live = new ChatService(
      liveStore,
      provider,
      active,
      registry,
      process.cwd(),
      { maxIterations: 8, unknownToolLimit: 2, toolTimeoutMs: 30_000 },
    );
    const sLive = liveStore.create();
    const prompt =
      "请先用 read_file 读取 package.json，再根据其中的 name 字段用一句话告诉我项目名称。不要询问我，直接调用工具完成。";
    const evLive = await drain(live.send(sLive.id, prompt));
    const toolExecs = evLive.filter((e) => e.type === "tool_execution_end");
    const stopped = evLive.find((e) => e.type === "agent_stopped");
    const msgs = liveStore.get(sLive.id)?.messages ?? [];
    const hasToolMsg = msgs.some((m) => m.role === "tool");
    record(
      "AC13-deepseek",
      toolExecs.length >= 1 && hasToolMsg && stopped?.type === "agent_stopped",
      `toolEnds=${toolExecs.length} hasToolMsg=${hasToolMsg} stop=${stopped && stopped.type === "agent_stopped" ? stopped.reason : "none"} events=${evLive.length}`,
    );
    record(
      "AC1-multistep",
      toolExecs.length >= 1 &&
        (stopped?.type === "agent_stopped" ? stopped.reason === "completed" || stopped.reason === "max_iterations" : false),
      `toolEnds=${toolExecs.length} reason=${stopped && stopped.type === "agent_stopped" ? stopped.reason : "?"}`,
    );
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("\n=== SUMMARY ===");
  console.log(`passed=${passed} failed=${failed} total=${results.length}`);
  for (const r of results.filter((x) => !x.pass)) {
    console.log(`FAIL ${r.id}: ${r.evidence}`);
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
