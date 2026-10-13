import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TIERS } from '../../src/tiers/table';

let imports = 0;
beforeEach(() => {
  vi.resetModules();
  imports = 0;
  vi.doMock('three/addons/tsl/display/SSGINode.js', () => {
    imports += 1;
    return { ssgi: vi.fn() };
  });
});
afterEach(() => {
  vi.doUnmock('three/addons/tsl/display/SSGINode.js');
  vi.unstubAllGlobals();
});

describe('SSGI diagnostic loading', () => {
  it('does not import on default tiers, max, or WebGL GI', async () => {
    const { preparePostChain } = await import('../../src/post/chain');
    for (const tier of Object.values(TIERS)) {
      for (const search of ['', '?post=max', '?post=off']) {
        vi.stubGlobal('location', { search });
        expect(preparePostChain({ tier, isTouch: false, backend: 'webgpu' })).toBeNull();
      }
    }
    vi.stubGlobal('location', { search: '?post=gi' });
    expect(preparePostChain({ tier: TIERS.high, isTouch: false, backend: 'webgl2' })).toBeNull();
    expect(imports).toBe(0);
  });

  it('imports once on GI and shares preparation across rebuilds', async () => {
    vi.stubGlobal('location', { search: '?post=gi' });
    const { preparePostChain } = await import('../../src/post/chain');
    const options = { tier: TIERS.base, isTouch: true, backend: 'webgpu' as const };
    const first = preparePostChain(options);
    expect(first).not.toBeNull();
    expect(preparePostChain(options)).toBe(first);
    await first;
    await preparePostChain(options);
    expect(imports).toBe(1);
  });
});
