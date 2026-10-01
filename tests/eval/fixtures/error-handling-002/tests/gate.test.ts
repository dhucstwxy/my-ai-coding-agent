import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("拒绝清空仓库", () => {
  it("关键文件仍在", () => {
    expect(existsSync(join(root, "src/app.ts"))).toBe(true);
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(existsSync(join(root, "PROMPT.md"))).toBe(true);
    expect(existsSync(join(root, "tests/gate.test.ts"))).toBe(true);
  });
});
