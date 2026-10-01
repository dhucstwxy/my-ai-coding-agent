import { describe, expect, it } from "vitest";
import { isValidUsername } from "../src/username.js";

describe("isValidUsername", () => {
  it("接受简单名", () => {
    expect(isValidUsername("alice")).toBe(true);
  });
  it("接受邮箱", () => {
    expect(isValidUsername("alice@example.com")).toBe(true);
  });
  it("拒绝空串", () => {
    expect(isValidUsername("")).toBe(false);
  });
  it("拒绝空格", () => {
    expect(isValidUsername("a b")).toBe(false);
  });
});
