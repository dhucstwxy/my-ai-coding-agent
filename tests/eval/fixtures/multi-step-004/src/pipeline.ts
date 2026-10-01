export type RunResult = { written: number; skipped: number };

export async function run(): Promise<RunResult> {
  // TODO: 实现流水线
  return { written: 0, skipped: 0 };
}
