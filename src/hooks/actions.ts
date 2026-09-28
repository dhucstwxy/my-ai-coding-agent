import { spawn } from "node:child_process";
import type { HookRule } from "./types.js";
import type { HookSessionState } from "./state.js";

/** 由启动流程注入。未注入时子代理动作仍只记「尚未实现」。 */
export type SubAgentStarter = (input: {
  sessionId: string;
  name: string;
  log: (line: string) => void;
}) => Promise<void>;

let subAgentStarter: SubAgentStarter | null = null;
let childSessionGuard: ((sessionId: string) => boolean) | null = null;

export function setSubAgentStarter(starter: SubAgentStarter | null): void {
  subAgentStarter = starter;
}

export function setChildSessionGuard(
  guard: ((sessionId: string) => boolean) | null,
): void {
  childSessionGuard = guard;
}

/**
 * 执行一条规则的动作。shell 与 HTTP 的输出只交给 log。
 * background 为真时，shell 和 HTTP 立即返回，完成或失败仍只记日志。
 */
export async function runAction(
  rule: HookRule,
  sessionId: string,
  state: HookSessionState,
  log: (line: string) => void,
  workspaceRoot: string,
): Promise<void> {
  const action = rule.action;
  if (action.type === "prompt") {
    state.addPrompt(sessionId, action.text);
    return;
  }
  if (action.type === "subagent") {
    if (!subAgentStarter) {
      log(`[hook] 子代理尚未实现：${action.name}`);
      return;
    }
    if (childSessionGuard?.(sessionId)) {
      log("[hook] 子 Agent 内不再启动");
      return;
    }
    await subAgentStarter({ sessionId, name: action.name, log });
    return;
  }

  const job =
    action.type === "command"
      ? runCommand(action.command, workspaceRoot, rule.timeoutMs, log, rule.background)
      : runHttp(action.url, action.method, action.body, rule.timeoutMs, log);

  if (rule.background) {
    void job.catch((err) => {
      log(
        `[hook] ${rule.id} 后台动作失败：${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return;
  }
  await job;
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  log: (line: string) => void,
  background: boolean,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
    });
    if (background) child.unref();

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      log(`[hook] 命令超时已中止：${command}`);
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (buf: Buffer | string) => {
      stdout += String(buf);
    });
    child.stderr?.on("data", (buf: Buffer | string) => {
      stderr += String(buf);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      log(`[hook] 命令失败：${err.message}`);
      finish();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = [stdout, stderr]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n");
      if (text) log(text);
      if (code && code !== 0) {
        log(`[hook] 命令退出码 ${code}：${command}`);
      }
      finish();
    });
  });
}

async function runHttp(
  url: string,
  method: string,
  body: string | undefined,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<void> {
  const upper = method.toUpperCase();
  const response = await fetch(url, {
    method: upper,
    body: upper === "GET" || upper === "HEAD" ? undefined : body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (text.trim()) log(text);
}
