/** 可在 Agent 循环各间隙检查的取消令牌 */
export interface CancelToken {
  readonly isCancelled: boolean;
  cancel(): void;
}

export function createCancelToken(): CancelToken {
  let cancelled = false;
  return {
    get isCancelled() {
      return cancelled;
    },
    cancel() {
      cancelled = true;
    },
  };
}
