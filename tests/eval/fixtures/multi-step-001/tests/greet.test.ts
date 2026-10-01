import { describe, expect, it } from "vitest";
import { greet } from "../src/greet.js";

describe("greet", () => {
  it("格式正确", () => {
    expect(greet("Mew")).toBe("Hello, Mew!");
  });
});
