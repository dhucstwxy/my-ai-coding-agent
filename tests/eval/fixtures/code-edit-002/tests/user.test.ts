import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatUser } from "../src/user.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("formatUser", () => {
  it("输出格式不变", () => {
    expect(formatUser({ id: "7", first: "Ada", last: "Lovelace" })).toBe(
      "#7 Lovelace, Ada"
    );
  });

  it("源码复用 formatName", () => {
    const src = readFileSync(join(root, "src/user.ts"), "utf8");
    expect(src).toMatch(/formatName/);
    expect(src).toMatch(/from\s+["'].*format/);
  });
});
