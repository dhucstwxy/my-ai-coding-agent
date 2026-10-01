import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkoutTotal } from "../src/checkout.js";
import { calcTax } from "../src/tax.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("tax + checkout", () => {
  it("calcTax", () => {
    expect(existsSync(join(root, "src/tax.ts"))).toBe(true);
    expect(calcTax(100, 0.1)).toBe(10);
  });

  it("checkout 接入税费", () => {
    expect(checkoutTotal(100, 0.1)).toBe(110);
    const src = readFileSync(join(root, "src/checkout.ts"), "utf8");
    expect(src).toMatch(/calcTax/);
  });
});
