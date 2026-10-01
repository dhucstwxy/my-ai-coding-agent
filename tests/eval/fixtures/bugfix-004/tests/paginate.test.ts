import { describe, expect, it } from "vitest";
import { paginate } from "../src/paginate.js";

const items = [1, 2, 3, 4, 5];

describe("paginate", () => {
  it("第一页", () => {
    expect(paginate(items, 1, 2)).toEqual([1, 2]);
  });
  it("最后一页不足", () => {
    expect(paginate(items, 3, 2)).toEqual([5]);
  });
  it("超出返回空", () => {
    expect(paginate(items, 9, 2)).toEqual([]);
  });
  it("空列表", () => {
    expect(paginate([], 1, 10)).toEqual([]);
  });
});
