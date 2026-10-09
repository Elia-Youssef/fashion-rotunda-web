// Dynamic resolution scale. Pure state machine: every update carries the caller's
// clock reading, so the class never reads the clock itself and tests need no timers.

export interface ScalerOptions {
  budgetMs: number;
  steps: readonly number[];
  downAfterMs?: number;
  upAfterMs?: number;
}

const DEFAULT_DOWN_AFTER_MS = 2000;
const DEFAULT_UP_AFTER_MS = 5000;

export class ResolutionScaler {
  private readonly budgetMs: number;
  private readonly steps: readonly number[];
  private readonly downAfterMs: number;
  private readonly upAfterMs: number;
  private index = 0;
  private streakStart: number | null = null;
  private streakOver = false;

  constructor(options: ScalerOptions) {
    this.budgetMs = options.budgetMs;
    this.steps = options.steps;
    this.downAfterMs = options.downAfterMs ?? DEFAULT_DOWN_AFTER_MS;
    this.upAfterMs = options.upAfterMs ?? DEFAULT_UP_AFTER_MS;
  }

  /**
   * Applies the p95 measured since the last call. A p95 exactly equal to the budget is inside
   * the budget, hence the strict comparison. Stepping requires the same side held continuously
   * for the whole window; any flip restarts the streak, and each step restarts it too, so one
   * bad blip cannot walk the scale down on its own.
   */
  update(p95Ms: number, nowMs: number): number {
    const over = p95Ms > this.budgetMs;
    if (this.streakStart === null || over !== this.streakOver) {
      this.streakOver = over;
      this.streakStart = nowMs;
    }
    const elapsed = nowMs - this.streakStart;
    if (over && elapsed >= this.downAfterMs) {
      this.index = Math.min(this.index + 1, this.steps.length - 1);
      this.streakStart = nowMs;
    } else if (!over && elapsed >= this.upAfterMs) {
      this.index = Math.max(this.index - 1, 0);
      this.streakStart = nowMs;
    }
    return this.steps[this.index];
  }

  get scale(): number {
    return this.steps[this.index];
  }

  reset(): void {
    this.index = 0;
    this.streakStart = null;
    this.streakOver = false;
  }
}
