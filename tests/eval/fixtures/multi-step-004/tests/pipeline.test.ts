import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/pipeline.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(root, "out", "users.json");

describe("pipeline", () => {
  beforeEach(() => {
    if (existsSync(outFile)) rmSync(outFile);
  });

  it("写出合法用户并计数跳过", async () => {
    const result = await run();
    expect(result).toEqual({ written: 2, skipped: 2 });
    expect(existsSync(outFile)).toBe(true);
    const users = JSON.parse(readFileSync(outFile, "utf8")) as Array<{
      id: string;
      name: string;
      email: string;
    }>;
    expect(users).toEqual([
      { id: "1", name: "Ada", email: "ada@example.com" },
      { id: "4", name: "Dan", email: "dan@example.com" },
    ]);
  });
});
