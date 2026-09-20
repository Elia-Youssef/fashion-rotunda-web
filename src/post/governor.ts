// Goal G3.5: the frame-time governor. Pure, no three.js, so the p95 window, the patience,
// the ladder and the degradation rule are testable in node.
//
// The governor steps enhanced post-processing down when the measured frame work time repeatedly
// misses the tier budget, so the page never stutters to show off. Degradation is one-way: once
// stepped down, the level never re-ascends within the session.
//
// At the base level, the post chain keeps LUT and vignette (a single 3D texture lookup and math pass)
// while dropping heavy passes (SSGI, SSR) as well as bloom and depth of field.

export type EnhancedLevel = 'full' | 'ssgi-half' | 'no-ssgi' | 'no-ssr' | 'base';

export interface GovernorOptions {
  budgetMs: number;
  windowFrames: number;
  /** Consecutive windows over budget before stepping down; 2. */
  patience: number;
}

export interface Governor {
  /** Feeds one frame's work time; returns the level after the frame. */
  observe(workMs: number): EnhancedLevel;
  readonly level: EnhancedLevel;
  /** The order the levels degrade in, never re-ascending within a session. */
  readonly ladder: readonly EnhancedLevel[];
}

const LADDER: readonly EnhancedLevel[] = ['full', 'ssgi-half', 'no-ssgi', 'no-ssr', 'base'];

/**
 * Computes nearest-rank 95th percentile on a sorted copy of the window samples.
 * Nearest-rank matches FrameTimes.percentile: rank = ceil(0.95 * n), clamped to [1, n].
 */
function calculateP95(samples: readonly number[]): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((95 * sorted.length) / 100)));
  return sorted[rank - 1];
}

export function createGovernor(options: GovernorOptions): Governor {
  const { budgetMs, windowFrames, patience } = options;
  const samples: number[] = [];
  let currentIndex = 0;
  let consecutiveOverBudget = 0;

  return {
    observe(workMs: number): EnhancedLevel {
      samples.push(workMs);
      if (samples.length >= windowFrames) {
        const p95 = calculateP95(samples);
        samples.length = 0;

        if (p95 > budgetMs) {
          consecutiveOverBudget += 1;
          if (consecutiveOverBudget >= patience) {
            consecutiveOverBudget = 0;
            if (currentIndex < LADDER.length - 1) {
              currentIndex += 1;
              const next = LADDER[currentIndex];
              console.info(`[archviz] post governor stepped down to ${next} (p95 was ${p95.toFixed(1)} ms)`);
            }
          }
        } else {
          consecutiveOverBudget = 0;
        }
      }
      return LADDER[currentIndex];
    },

    get level(): EnhancedLevel {
      return LADDER[currentIndex];
    },

    get ladder(): readonly EnhancedLevel[] {
      return LADDER;
    },
  };
}
