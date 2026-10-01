import { PriceService } from "./price-service.js";
import { buildQuote } from "./quote.js";

export function checkoutTotal(skus: string[]): number {
  const service = new PriceService();
  return buildQuote(service, skus);
}
