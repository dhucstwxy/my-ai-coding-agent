import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("answer.json", () => {
  it("最终 timeout 与来源", () => {
    const p = join(root, "answer.json");
    expect(existsSync(p)).toBe(true);
    const data = JSON.parse(readFileSync(p, "utf8")) as {
      timeoutMs?: number;
      sourceFile?: string;
    };
    expect(data.timeoutMs).toBe(3000);
    expect(data.sourceFile).toBe("src/config/env.json");
  });
});
