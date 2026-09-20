import { describe, expect, it, vi } from 'vitest';
import { createGovernor } from '../../src/post/governor';
import type { EnhancedLevel } from '../../src/post/governor';

describe('post governor', () => {
  const defaultOptions = {
    budgetMs: 16.7,
    windowFrames: 60,
    patience: 2,
  };

  it('starts at full level and exposes the degradation ladder', () => {
    const gov = createGovernor(defaultOptions);
    expect(gov.level).toBe('full');
    expect(gov.ladder).toEqual(['full', 'ssgi-half', 'no-ssgi', 'no-ssr', 'base']);
  });

  it('does not step down while frame work times remain under budget', () => {
    const gov = createGovernor(defaultOptions);
    // Feed 180 frames (3 full windows) well under 16.7 ms budget.
    for (let i = 0; i < 180; i += 1) {
      expect(gov.observe(10.0)).toBe('full');
    }
    expect(gov.level).toBe('full');
  });

  it('evaluates p95 per window and obeys patience before stepping down', () => {
    const gov = createGovernor(defaultOptions);

    // Window 1: 56 frames at 10 ms, 4 frames at 25 ms.
    // Nearest-rank p95 (rank 57 of 60) is 25 ms, which is over budget 16.7 ms.
    for (let i = 0; i < 56; i += 1) {
      gov.observe(10.0);
    }
    for (let i = 0; i < 4; i += 1) {
      gov.observe(25.0);
    }
    // Only 1 window over budget, patience is 2: should still be full.
    expect(gov.level).toBe('full');

    // Window 2: another window with p95 over budget.
    for (let i = 0; i < 56; i += 1) {
      gov.observe(10.0);
    }
    for (let i = 0; i < 3; i += 1) {
      gov.observe(25.0);
    }
    // 59th frame of window 2: still full before completion.
    expect(gov.level).toBe('full');
    // 60th frame: second window completes over budget. Patience reached -> step down to ssgi-half.
    const level = gov.observe(25.0);
    expect(level).toBe('ssgi-half');
    expect(gov.level).toBe('ssgi-half');
  });

  it('resets consecutive over-budget count when a window comes in under budget', () => {
    const gov = createGovernor(defaultOptions);

    // Window 1: over budget.
    for (let i = 0; i < 60; i += 1) {
      gov.observe(20.0);
    }
    expect(gov.level).toBe('full');

    // Window 2: under budget. Resets consecutive count to 0.
    for (let i = 0; i < 60; i += 1) {
      gov.observe(12.0);
    }
    expect(gov.level).toBe('full');

    // Window 3: over budget again. This is consecutive count 1, not 2.
    for (let i = 0; i < 60; i += 1) {
      gov.observe(20.0);
    }
    expect(gov.level).toBe('full');

    // Window 4: second consecutive over budget -> steps down.
    for (let i = 0; i < 60; i += 1) {
      gov.observe(20.0);
    }
    expect(gov.level).toBe('ssgi-half');
  });

  it('degrades down the entire ladder in order and stops at base', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gov = createGovernor(defaultOptions);

    const expectedSteps: EnhancedLevel[] = ['ssgi-half', 'no-ssgi', 'no-ssr', 'base'];
    for (const step of expectedSteps) {
      // 2 windows over budget per step (patience = 2).
      for (let window = 0; window < 2; window += 1) {
        for (let frame = 0; frame < 60; frame += 1) {
          gov.observe(22.0);
        }
      }
      expect(gov.level).toBe(step);
    }

    expect(gov.level).toBe('base');

    // Further over-budget windows cannot degrade past base.
    for (let i = 0; i < 120; i += 1) {
      gov.observe(30.0);
    }
    expect(gov.level).toBe('base');

    expect(consoleSpy).toHaveBeenCalledTimes(4);
    for (let idx = 0; idx < expectedSteps.length; idx += 1) {
      expect(consoleSpy.mock.calls[idx][0]).toContain(`stepped down to ${expectedSteps[idx]}`);
      expect(consoleSpy.mock.calls[idx][0]).toContain('[archviz]');
    }

    consoleSpy.mockRestore();
  });

  it('never ascends even when subsequent windows run far below budget', () => {
    const gov = createGovernor(defaultOptions);

    // Step down to ssgi-half.
    for (let i = 0; i < 120; i += 1) {
      gov.observe(25.0);
    }
    expect(gov.level).toBe('ssgi-half');

    // Feed 300 frames (5 windows) at 5 ms (well below 16.7 ms budget).
    for (let i = 0; i < 300; i += 1) {
      expect(gov.observe(5.0)).toBe('ssgi-half');
    }
    expect(gov.level).toBe('ssgi-half');
  });

  it('allows caller to exclude idle frames from feeding the window', () => {
    const gov = createGovernor({ budgetMs: 16.7, windowFrames: 10, patience: 1 });

    // Caller feeds only active drawn frames.
    // 5 active frames at 25 ms.
    for (let i = 0; i < 5; i += 1) {
      gov.observe(25.0);
    }
    // 20 idle frames occur in the loop, but caller excludes them (does not call observe).
    // The governor window must remain at 5 frames and not step down.
    expect(gov.level).toBe('full');

    // 5 more active frames complete the 10-frame window.
    for (let i = 0; i < 5; i += 1) {
      gov.observe(25.0);
    }
    expect(gov.level).toBe('ssgi-half');
  });
});
