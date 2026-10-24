import fs from "node:fs";
import readline from "node:readline";
import { createCancelToken, type CancelToken } from "../agent/cancel.js";
import { runHeadless } from "../run/runner.js";
import { DEFAULT_RUN_TIMEOUT_MS } from "../run/types.js";

/**
 * 常驻 JSONL worker。stdout 只写协议，日志走 stderr。
 * FastAPI 拉起本进程，用 stdin 下发 run / cancel / shutdown。
 *
 * 请求：
 *   {"type":"run","requestId","workspace","prompt","sessionId?","timeoutMs?","sessionsDir","configRoot?","resume?"}
 *   {"type":"cancel","requestId"}
 *   {"type":"shutdown"}
 * 响应：
 *   {"type":"ready","v":1}
 *   {"type":"session","requestId","sessionId"}
 *   {"type":"event","requestId","event"}
 *   {"type":"result","requestId","exitCode","report"}
 *   {"type":"error","requestId?","message"}
 */

interface RunCommand {
  type: "run";
  requestId: string;
  workspace: string;
  prompt: string;
  sessionId?: string;
  timeoutMs?: number;
  sessionsDir: string;
  configRoot?: string;
  resume?: boolean;
}

const inflight = new Map<string, CancelToken>();
let chain: Promise<void> = Promise.resolve();
let stopping = false;

function emit(obj: unknown): void {
  let line: string;
  try {
    line = JSON.stringify(obj);
  } catch (err) {
    line = JSON.stringify({
      type: "error",
      message: `事件无法序列化：${err instanceof Error ? err.message : String(err)}`,
    });
  }
  // 同步写 fd 1，避免管道块缓冲把 ready 卡住
  fs.writeSync(1, `${line}\n`);
}

function logLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** 避免业务代码的 console.log 污染 stdout 协议 */
function redirectConsoleToStderr(): void {
  const write = (...args: unknown[]) => {
    const text = args
      .map((item) => {
        if (typeof item === "string") return item;
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .join(" ");
    process.stderr.write(`${text}\n`);
  };
  console.log = write;
  console.info = write;
  console.debug = write;
}

async function handleRun(cmd: RunCommand, cancel: CancelToken): Promise<void> {
  if (stopping) {
    emit({
      type: "error",
      requestId: cmd.requestId,
      message: "worker 正在关闭",
    });
    inflight.delete(cmd.requestId);
    return;
  }

  try {
    const { report, exitCode } = await runHeadless({
      workspace: cmd.workspace,
      prompt: cmd.prompt,
      promptSource: "arg",
      configRoot: cmd.configRoot,
      sessionsDir: cmd.sessionsDir,
      timeoutMs:
        typeof cmd.timeoutMs === "number" && cmd.timeoutMs > 0
          ? cmd.timeoutMs
          : DEFAULT_RUN_TIMEOUT_MS,
      sessionId: cmd.sessionId,
      resume: cmd.resume === true,
      cancel,
      log: logLine,
      onSession: (sessionId) => {
        emit({ type: "session", requestId: cmd.requestId, sessionId });
      },
      onEvent: (event) => {
        emit({ type: "event", requestId: cmd.requestId, event });
      },
    });
    emit({ type: "result", requestId: cmd.requestId, exitCode, report });
  } catch (err) {
    emit({
      type: "error",
      requestId: cmd.requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    inflight.delete(cmd.requestId);
  }
}

function enqueue(cmd: RunCommand, cancel: CancelToken): void {
  chain = chain
    .then(() => handleRun(cmd, cancel))
    .catch((err: unknown) => {
      logLine(
        `[worker] 运行失败：${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

export async function runServeWorker(): Promise<void> {
  redirectConsoleToStderr();
  emit({ type: "ready", v: 1 });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object") {
        emit({ type: "error", message: "无法解析 JSON" });
        continue;
      }
      msg = parsed as Record<string, unknown>;
    } catch {
      emit({ type: "error", message: "无法解析 JSON" });
      continue;
    }

    if (msg.type === "shutdown") {
      stopping = true;
      for (const token of inflight.values()) token.cancel();
      break;
    }

    if (msg.type === "cancel") {
      if (typeof msg.requestId === "string") {
        inflight.get(msg.requestId)?.cancel();
      }
      continue;
    }

    if (msg.type === "run") {
      const requestId = msg.requestId;
      const workspace = msg.workspace;
      const prompt = msg.prompt;
      const sessionsDir = msg.sessionsDir;
      if (
        typeof requestId !== "string" ||
        typeof workspace !== "string" ||
        typeof prompt !== "string" ||
        typeof sessionsDir !== "string"
      ) {
        emit({
          type: "error",
          requestId: typeof requestId === "string" ? requestId : undefined,
          message: "run 缺少 requestId、workspace、prompt 或 sessionsDir",
        });
        continue;
      }
      if (inflight.has(requestId)) {
        emit({
          type: "error",
          requestId,
          message: "重复的 requestId",
        });
        continue;
      }
      const cancel = createCancelToken();
      inflight.set(requestId, cancel);
      enqueue(
        {
          type: "run",
          requestId,
          workspace,
          prompt,
          sessionsDir,
          sessionId:
            typeof msg.sessionId === "string" ? msg.sessionId : undefined,
          timeoutMs:
            typeof msg.timeoutMs === "number" ? msg.timeoutMs : undefined,
          configRoot:
            typeof msg.configRoot === "string" ? msg.configRoot : undefined,
          resume: msg.resume === true,
        },
        cancel,
      );
      continue;
    }

    emit({ type: "error", message: `未知命令：${String(msg.type)}` });
  }

  stopping = true;
  for (const token of inflight.values()) token.cancel();
  await chain;
}
