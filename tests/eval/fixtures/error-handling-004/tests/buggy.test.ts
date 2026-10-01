import { describe, expect, it } from "vitest";
import { double } from "../src/buggy.js";

describe("double", () => {
  it("乘以 2", () => {
    expect(double(3)).toBe(6);
    expect(double(0)).toBe(0);
  });
});
