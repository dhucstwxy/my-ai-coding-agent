import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED: Record<string, string> = {
  "tests/paginate.test.ts": "e41426fd9095086d31e23323a3e9e62976ac68a9ddf81650c8454631b173090b",
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
