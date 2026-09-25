import { SUMMARY_FAIL_LIMIT } from "./constants.js";

interface SessionCompactState {
  consecutiveSummaryFailures: number;
  autoCompactDisabled: boolean;
}

/** 进程内按会话维护重量压缩熔断状态 */
export class CompactStateStore {
  private readonly map = new Map<string, SessionCompactState>();

  private getOrCreate(sessionId: string): SessionCompactState {
    let s = this.map.get(sessionId);
    if (!s) {
      s = { consecutiveSummaryFailures: 0, autoCompactDisabled: false };
      this.map.set(sessionId, s);
    }
    return s;
  }

  isAutoDisabled(sessionId: string): boolean {
    return this.map.get(sessionId)?.autoCompactDisabled ?? false;
  }

  recordFailure(sessionId: string): {
    consecutive: number;
    circuitOpen: boolean;
  } {
    const s = this.getOrCreate(sessionId);
    s.consecutiveSummaryFailures += 1;
    if (s.consecutiveSummaryFailures >= SUMMARY_FAIL_LIMIT) {
      s.autoCompactDisabled = true;
    }
    return {
      consecutive: s.consecutiveSummaryFailures,
      circuitOpen: s.autoCompactDisabled,
    };
  }

  recordSuccess(sessionId: string): void {
    const s = this.getOrCreate(sessionId);
    s.consecutiveSummaryFailures = 0;
    s.autoCompactDisabled = false;
  }

  reset(sessionId: string): void {
    this.map.delete(sessionId);
  }
}
