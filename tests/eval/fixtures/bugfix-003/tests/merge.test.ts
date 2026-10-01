import { describe, expect, it } from "vitest";
import { mergeConfigs } from "../src/merge.js";

describe("mergeConfigs", () => {
  it("深合并嵌套对象", () => {
    const result = mergeConfigs(
      { db: { host: "localhost", port: 5432 }, debug: false },
      { db: { port: 15432 }, debug: true }
    );
    expect(result).toEqual({
      db: { host: "localhost", port: 15432 },
      debug: true,
    });
  });

  it("数组由 b 整体替换", () => {
    const result = mergeConfigs({ tags: ["a"] }, { tags: ["b", "c"] });
    expect(result.tags).toEqual(["b", "c"]);
  });
});
