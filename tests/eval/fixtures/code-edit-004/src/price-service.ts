export class PriceService {
  getPrice(sku: string): number {
    if (sku === "book") return 20;
    if (sku === "pen") return 5;
    return 0;
  }
}
