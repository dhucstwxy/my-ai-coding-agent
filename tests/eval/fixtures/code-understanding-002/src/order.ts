import { reserveStock } from "./inventory.js";
import { chargeCard } from "./payment.js";

export function placeOrder(sku: string, qty: number, amount: number): string {
  if (!reserveStock(sku, qty)) {
    throw new Error("stock");
  }
  return chargeCard(amount);
}
