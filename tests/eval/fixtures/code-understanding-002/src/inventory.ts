export function reserveStock(sku: string, qty: number): boolean {
  return qty > 0 && sku.length > 0;
}
