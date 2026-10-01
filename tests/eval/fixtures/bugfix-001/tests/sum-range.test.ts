import { describe, expect, it } from "vitest";
import { sumRange } from "../src/sum-range.js";

describe("sumRange", () => {
  it("1..3 = 6", () => {
    expect(sumRange(1, 3)).toBe(6);
  });
  it("0..0 = 0", () => {
    expect(sumRange(0, 0)).toBe(0);
  });
  it("2..5 = 14", () => {
    expect(sumRange(2, 5)).toBe(14);
  });
});
