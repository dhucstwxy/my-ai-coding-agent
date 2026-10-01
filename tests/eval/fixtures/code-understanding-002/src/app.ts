import { placeOrder } from "./order.js";

export function startCheckout(sku: string, qty: number, amount: number): string {
  return placeOrder(sku, qty, amount);
}
