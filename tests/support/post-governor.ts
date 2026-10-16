import { expect } from 'vitest';
import { createGovernor, RECOVERY_THRESHOLD_RATIO } from '../../src/post/governor';
import type { EnhancedLevel, Governor } from '../../src/post/governor';

// One-way degradation and safe recovery. Every test drives the governor on a
// deterministic fake clock: observe() takes the monotonic nowMs the decision clock runs on, so
// ten seconds of qualification and cooldown are exact integers here and wall time never leaks in.

export const BUDGET_MS = 16.7;
export const THRESHOLD_MS = BUDGET_MS * RECOVERY_THRESHOLD_RATIO;

export interface Sample {
  workMs: number;
  atMs: number;
  eligible?: boolean;
}

export function feed(gov: Governor, samples: readonly Sample[]): EnhancedLevel {
  let level = gov.level;
  for (const sample of samples) {
    level = gov.observe(sample.workMs, sample.atMs, sample.eligible ?? true);
  }
  return level;
}

/** count samples at startAt + k*gap for k = 0..count-1. */
export function span(
  count: number,
  workMs: number,
  startAt: number,
  gap: number,
  eligible = true,
): Sample[] {
  const samples: Sample[] = [];
  for (let k = 0; k < count; k += 1) {
    samples.push({ workMs, atMs: startAt + k * gap, eligible });
  }
  return samples;
}

/**
 * Two over-budget windows of ten samples each, ten milliseconds apart: the governor decides at
 * t=200, lands on ssgi-half, and owes a cooldown until t=10200. Every recovery test starts here.
 */
export function degradedAtSsgiHalf(overWorkMs = 40): { gov: Governor; decidedAt: number } {
  const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 });
  feed(gov, span(20, overWorkMs, 10, 10));
  expect(gov.level).toBe('ssgi-half');
  return { gov, decidedAt: 200 };
}

/** A comfortable work value safely under the 80% threshold (13.36 ms of the 16.7 ms budget). */
export const COMFORTABLE_MS = 8;
