import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("answer.json", () => {
  it("callChain 顺序正确", () => {
    const p = join(root, "answer.json");
    expect(existsSync(p)).toBe(true);
    const data = JSON.parse(readFileSync(p, "utf8")) as { callChain?: string[] };
    expect(data.callChain).toEqual([
      "startCheckout",
      "placeOrder",
      "reserveStock",
      "chargeCard",
    ]);
  });
});
