import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED: Record<string, string> = {
  "tests/async-price.test.ts": "00ef5af57db858ebf3d9196b293330bfa26afe3022c01815cdc8c22cd75ee96c",
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
