import { spawn } from "node:child_process";

export interface VerifyResult {
  exitCode: number;
  timedOut: boolean;
  stderr: string;
}

/** 在工作区执行验证命令（如 npm test） */
export function runVerify(
  cwd: string,
  command: string,
  timeoutMs: number,
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ exitCode: 1, timedOut: true, stderr: stderr.slice(0, 2000) });
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        timedOut: false,
        stderr: err.message,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        timedOut: false,
        stderr: stderr.slice(0, 2000),
      });
    });
  });
}
