import { describe, expect, it } from "vitest";
import { PriceService } from "../src/price-service.js";
import { buildQuote } from "../src/quote.js";
import { checkoutTotal } from "../src/checkout.js";

describe("async price", () => {
  it("getPrice 返回 Promise", async () => {
    const service = new PriceService();
    const result = service.getPrice("book");
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(20);
  });

  it("buildQuote 异步汇总", async () => {
    const total = await buildQuote(new PriceService(), ["book", "pen"]);
    expect(total).toBe(25);
  });

  it("checkoutTotal 异步", async () => {
    await expect(checkoutTotal(["book", "pen"])).resolves.toBe(25);
  });
});
