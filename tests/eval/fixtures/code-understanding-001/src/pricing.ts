/** 按折扣率计算成交价 */
export function applyDiscount(price: number, rate: number = 0.15): number {
  return price * (1 - rate);
}

export function formatMoney(n: number): string {
  return n.toFixed(2);
}
