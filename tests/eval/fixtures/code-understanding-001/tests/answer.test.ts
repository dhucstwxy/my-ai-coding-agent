import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("answer.json", () => {
  it("包含正确的导出名与默认折扣率", () => {
    const p = join(root, "answer.json");
    expect(existsSync(p)).toBe(true);
    const data = JSON.parse(readFileSync(p, "utf8")) as {
      exportName?: string;
      defaultRate?: number;
    };
    expect(data.exportName).toBe("applyDiscount");
    expect(data.defaultRate).toBe(0.15);
  });
});
