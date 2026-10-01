import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED: Record<string, string> = {
  "tests/server.test.ts": "2c26aad048ae5cc091c07207372baa784a81436d9c132a4194b7c11eaf6c3a58",
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
