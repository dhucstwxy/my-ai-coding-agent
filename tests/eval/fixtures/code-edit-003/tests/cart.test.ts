import { describe, expect, it } from "vitest";
import { Cart } from "../src/cart.js";

describe("Cart.removeItem", () => {
  it("删除存在的 id", () => {
    const cart = new Cart()
      .addItem({ id: "a", name: "A", qty: 1 })
      .addItem({ id: "b", name: "B", qty: 2 });
    const next = cart.removeItem("a");
    expect(next.list().map((x) => x.id)).toEqual(["b"]);
    expect(cart.list()).toHaveLength(2);
  });

  it("不存在则内容不变", () => {
    const cart = new Cart().addItem({ id: "a", name: "A", qty: 1 });
    const next = cart.removeItem("missing");
    expect(next.list()).toEqual([{ id: "a", name: "A", qty: 1 }]);
  });
});
