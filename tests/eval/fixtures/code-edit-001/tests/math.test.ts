import { describe, expect, it } from "vitest";
import { clamp } from "../src/math.js";

describe("clamp", () => {
  it("低于 min", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });
  it("高于 max", () => {
    expect(clamp(99, 0, 10)).toBe(10);
  });
  it("区间内", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
});
