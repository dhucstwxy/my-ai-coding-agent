import type { Tool, ToolContext, ToolDefinition, ToolResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  toDefinitions(): ToolDefinition[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async execute(
    name: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        content: `未知工具：${name}`,
        errorCode: "invalid_args",
      };
    }

    const timeoutMs = ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULT_TIMEOUT_MS;
    const runCtx: ToolContext = { ...ctx, timeoutMs };

    try {
      return await withTimeout(tool.execute(args, runCtx), timeoutMs, name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("TIMEOUT:")) {
        return {
          ok: false,
          content: `工具执行超时（${timeoutMs}ms）：${name}`,
          errorCode: "timeout",
        };
      }
      return {
        ok: false,
        content: `工具执行异常：${message}`,
        errorCode: "invalid_args",
      };
    }
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  name: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`TIMEOUT:${name}`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
