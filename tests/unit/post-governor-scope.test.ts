import { describe, expect, it } from 'vitest';
import { governorOperates } from '../../src/post/governor';
import { postChainRebuildAllowed } from '../../src/post/chain';

// Where a governor exists at all: the backend, the forced post slice and the tier's graph shape.

describe('post governor: where a governor exists at all (matrix 25)', () => {
  // The chain builds no governor for the WebGL 2 backend, for any forced `?post=` slice, or on
  // the pass-through fallback path, so those modes can neither degrade nor recover; the pure
  // rule below is the one the chain reads (chain.ts applyDevSwitch) so it cannot drift.
  const enhancedHigh = { ssgi: 'full-with-half-fallback' as const, ssr: true };
  const midWithoutCompute = { ssgi: 'off' as const, ssr: false };

  it('operates only on the unforced enhanced WebGPU path', () => {
    expect(governorOperates('webgpu', enhancedHigh, false)).toBe(true);
    expect(governorOperates('webgpu', enhancedHigh, true)).toBe(false); // ?post= slice
    expect(governorOperates('webgl2', enhancedHigh, false)).toBe(false);
    expect(governorOperates('webgl2', enhancedHigh, true)).toBe(false);
    expect(governorOperates('webgpu', midWithoutCompute, false)).toBe(false); // no SSGI/SSR tier
  });

  it('operates whenever either heavy effect is present, not only both', () => {
    // SSR without SSGI is the shorter-ladder graph; SSGI without SSR is the
    // diagnostic graph. Either heavy effect alone still needs the ladder.
    expect(governorOperates('webgpu', { ssgi: 'off', ssr: true }, false)).toBe(true);
    expect(governorOperates('webgpu', { ssgi: 'full-with-half-fallback', ssr: false }, false)).toBe(true);
  });

  it('keeps a runtime pass-through fallback through a CSS-box resize', () => {
    expect(postChainRebuildAllowed(false)).toBe(true);
    expect(postChainRebuildAllowed(true)).toBe(false);
  });
});
