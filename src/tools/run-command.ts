import { spawn } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { truncateText } from "./truncate.js";

export const runCommandTool: Tool = {
  name: "run_command",
  sideEffect: true,
  description:
    "在工作区根目录下执行 shell 命令，返回标准输出、标准错误与退出码。超时会被中止。仅用于构建、测试、git 等确需 shell 的操作；读文件、搜代码、找文件请用专用工具，不要用本工具代替。",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
    },
    required: ["command"],
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const command = (args as { command?: unknown })?.command;
    if (typeof command !== "string" || command.trim() === "") {
      return {
        ok: false,
        content: "参数 command 必须是非空字符串",
        errorCode: "invalid_args",
      };
    }

    try {
      const result = await runShell(command, ctx.workspaceRoot, ctx.timeoutMs);
      const body = [
        `exitCode: ${result.exitCode}`,
        "--- stdout ---",
        result.stdout || "(空)",
        "--- stderr ---",
        result.stderr || "(空)",
      ].join("\n");

      if (result.timedOut) {
        return {
          ok: false,
          content: truncateText(`命令超时（${ctx.timeoutMs}ms）\n${body}`),
          errorCode: "timeout",
        };
      }

      if (result.exitCode !== 0) {
        return {
          ok: false,
          content: truncateText(body),
          errorCode: "invalid_args",
        };
      }

      return { ok: true, content: truncateText(body) };
    } catch (err) {
      return {
        ok: false,
        content: `执行失败：${err instanceof Error ? err.message : String(err)}`,
        errorCode: "invalid_args",
      };
    }
  },
};

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Windows 上再给一点时间后强制结束
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1000).unref();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr || err.message,
        exitCode: 1,
        timedOut,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? (timedOut ? 1 : 0),
        timedOut,
      });
    });
  });
}
