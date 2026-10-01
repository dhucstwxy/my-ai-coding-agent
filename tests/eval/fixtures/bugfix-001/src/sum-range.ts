/** 计算闭区间 [start, end] 的整数和 */
export function sumRange(start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) {
    sum += i;
  }
  return sum;
}
