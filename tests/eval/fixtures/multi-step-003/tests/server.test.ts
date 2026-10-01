import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as logger from "../src/logger.js";
import { handleRequest } from "../src/server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("logger wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("server 源码不再直接 console", () => {
    const src = readFileSync(join(root, "src/server.ts"), "utf8");
    expect(src).not.toMatch(/console\.(log|error)/);
    expect(src).toMatch(/logger/);
  });

  it("通过 logger 输出", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    handleRequest(true);
    handleRequest(false);
    expect(info).toHaveBeenCalledWith("ok");
    expect(error).toHaveBeenCalledWith("fail");
  });
});
