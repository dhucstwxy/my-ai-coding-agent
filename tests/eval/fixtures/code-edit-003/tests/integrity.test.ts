import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED: Record<string, string> = {
  "tests/cart.test.ts": "800caf87da61a200f67b09906e28fb1e4e3d8de65276278ceaa8fd16241a1a41",
};

function hashFile(rel: string): string {
  const buf = readFileSync(join(root, rel));
  return createHash("sha256").update(buf).digest("hex");
}

describe("integrity", () => {
  for (const [rel, expected] of Object.entries(EXPECTED)) {
    it(`未篡改 ${rel}`, () => {
      expect(hashFile(rel)).toBe(expected);
    });
  }
});
