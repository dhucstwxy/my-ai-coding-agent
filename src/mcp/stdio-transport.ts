import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonRpcMessage, McpServerConfig, McpTransport } from "./types.js";

/**
 * 用子进程标准输入输出按行收发 JSON-RPC。
 * 标准错误只丢弃，不参与配对。
 */
export function createStdioTransport(
  config: Extract<McpServerConfig, { type: "stdio" }>,
  workspaceRoot: string,
): McpTransport {
  let handler: ((message: JsonRpcMessage) => void) | null = null;
  let closed = false;
  let stdoutBuf = "";

  const child: ChildProcessWithoutNullStreams = spawn(
    config.command,
    config.args,
    {
      cwd: workspaceRoot,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    },
  );

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let newline = stdoutBuf.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuf.slice(0, newline).replace(/\r$/, "");
      stdoutBuf = stdoutBuf.slice(newline + 1);
      if (line.trim() !== "") {
        try {
          const parsed = JSON.parse(line) as JsonRpcMessage;
          handler?.(parsed);
        } catch {
          /* 忽略坏行 */
        }
      }
      newline = stdoutBuf.indexOf("\n");
    }
  });

  child.stderr.on("data", () => {
    /* 丢弃标准错误，避免撑满管道 */
  });

  child.on("error", () => {
    /* spawn 失败由后续请求超时或 close 体现 */
  });

  return {
    async send(message) {
      if (closed) throw new Error("stdio 传输已关闭");
      if (!child.stdin.writable) throw new Error("stdio 子进程已退出");
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(`${JSON.stringify(message)}\n`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    onMessage(next) {
      handler = next;
    },
    async close() {
      if (closed) return;
      closed = true;
      handler = null;
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      if (!child.killed) {
        child.kill();
      }
    },
  };
}
