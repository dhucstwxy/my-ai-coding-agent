import { PriceService } from "./price-service.js";

export function buildQuote(service: PriceService, skus: string[]): number {
  return skus.reduce((sum, sku) => sum + service.getPrice(sku), 0);
}
