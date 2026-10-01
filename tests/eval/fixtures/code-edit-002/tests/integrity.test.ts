import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED: Record<string, string> = {
  "tests/user.test.ts": "acb6c9c6a0016fcc1a4f9b88666f979c5023aa5d0c985229a9f897d769b2ff58",
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
