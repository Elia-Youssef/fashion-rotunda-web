import { describe, expect, it } from 'vitest';

import type { TransitionDisruption, TransitionStableFrame } from '../../src/ui/scene-reveal';
import { assertDisruptionReset, assertFreshStableFrames } from '../e2e/support/reveal-disruption';

describe('retained reveal disruption assertions', () => {
  const reset: TransitionDisruption = {
    type: 'resize', source: 'window', generation: 4, stableFrames: 0, width: 820, height: 1180,
  };

  it('accepts a captured zero in a newer generation', () => {
    expect(() => assertDisruptionReset(reset, 3)).not.toThrow();
  });

  it.each([2, 3])('rejects handler delivery without a new generation: %s', (generation) => {
    expect(() => assertDisruptionReset({ ...reset, generation }, 3)).toThrow('did not advance');
  });

  it.each([1, 2])('rejects a handler that did not reset the counter: %s', (stableFrames) => {
    expect(() => assertDisruptionReset({ ...reset, stableFrames }, 3)).toThrow('did not reset stableFrames to 0');
  });

  it('accepts two fresh samples from one post-reset generation, including a later restart', () => {
    for (const generation of [reset.generation, reset.generation + 1]) {
      expect(() => assertFreshStableFrames([
        { generation, stableFrames: 1 }, { generation, stableFrames: 2 },
      ], reset.generation)).not.toThrow();
    }
  });

  it.each<{ name: string; samples: TransitionStableFrame[] }>([
    { name: 'no frames', samples: [] },
    { name: 'one frame', samples: [{ generation: 4, stableFrames: 2 }] },
    { name: 'stale handshake', samples: [{ generation: 3, stableFrames: 1 }, { generation: 3, stableFrames: 2 }] },
    { name: 'mixed generations', samples: [{ generation: 4, stableFrames: 1 }, { generation: 5, stableFrames: 2 }] },
    { name: 'uncounted black commit', samples: [{ generation: 4, stableFrames: 0 }, { generation: 4, stableFrames: 1 }] },
    { name: 'duplicate sample', samples: [{ generation: 4, stableFrames: 2 }, { generation: 4, stableFrames: 2 }] },
    { name: 'reversed samples', samples: [{ generation: 4, stableFrames: 2 }, { generation: 4, stableFrames: 1 }] },
  ])('rejects $name instead of accepting an old or incomplete handshake', ({ samples }) => {
    expect(() => assertFreshStableFrames(samples, reset.generation)).toThrow('two fresh stable frames');
  });
});
