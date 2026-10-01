import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("answer.json", () => {
  it("定位唯一写盘模块", () => {
    const p = join(root, "answer.json");
    expect(existsSync(p)).toBe(true);
    const data = JSON.parse(readFileSync(p, "utf8")) as {
      modulePath?: string;
      functionName?: string;
    };
    expect(data.modulePath).toBe("src/persist.ts");
    expect(data.functionName).toBe("saveToDisk");
  });
});
