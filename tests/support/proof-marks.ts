import { afterEach, beforeEach, vi } from 'vitest';

// The proof-marks harness shared by the proof-marks suites: the module-reset hooks every suite
// needs and the Resource Timing fake. The hooks register when this module loads, so every suite
// that imports the harness runs them, and Vitest's per-file isolation gives each suite its own
// marks module.

// marks.ts keeps "marked once" state at module scope, so each test re-imports a fresh copy.
beforeEach(() => {
  vi.resetModules();
  performance.clearMarks();
});

afterEach(() => {
  vi.restoreAllMocks();
  // restoreAllMocks covers spies only; unstubAllGlobals puts back a replaced performance object.
  vi.unstubAllGlobals();
});

export async function loadMarks(): Promise<typeof import('../../src/proof/marks')> {
  return await import('../../src/proof/marks');
}

/** A Resource Timing entry shape without casting: a PerformanceEntry with the extra fields. */
interface FakeResourceEntry extends PerformanceEntry {
  readonly transferSize: number;
  readonly encodedBodySize: number;
  readonly responseEnd: number;
}

export function fakeResource(
  name: string, transferSize: number, responseEnd: number, encodedBodySize = transferSize,
): FakeResourceEntry {
  const entry: FakeResourceEntry = {
    name,
    entryType: 'resource',
    startTime: 0,
    duration: responseEnd,
    transferSize,
    encodedBodySize,
    responseEnd,
    // Never called; PerformanceEntry declares toJSON so the fake must carry one.
    toJSON: (): FakeResourceEntry => entry,
  };
  return entry;
}
