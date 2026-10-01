export function estimateShipping(weightKg: number): number {
  return Math.max(5, weightKg * 2);
}
