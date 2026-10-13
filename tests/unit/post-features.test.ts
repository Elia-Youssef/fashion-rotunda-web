import { AgXToneMapping, BufferGeometry, Mesh, MeshStandardMaterial, PerspectiveCamera, RenderPipeline, Scene, SRGBColorSpace, Texture } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostChain } from '../../src/post/chain';
import type { PostChain, PostChainOptions } from '../../src/post/chain';
import type { Backend } from '../../src/post/settings';
import { TIERS } from '../../src/tiers/table';

// The features record the chain hands to the composition root, and the per-level settings the
// chain derives for the governor. The record is chain-owned and reused until a published value
// would change, so the composition root keys on its identity; the derived settings are cached per
// chain instance and per level. The settings module is wrapped in a counting passthrough so the
// second test can watch how often the derivation runs.

const mocked = vi.hoisted(() => ({ settingsForLevel: vi.fn() }));
vi.mock('../../src/post/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/post/settings')>();
  mocked.settingsForLevel.mockImplementation(actual.settingsForLevel);
  return { ...actual, settingsForLevel: mocked.settingsForLevel };
});

function fixture(backend: Backend, tier: 'base' | 'mid' | 'high', requestFrame: () => void) {
  const renderer = {
    toneMapping: AgXToneMapping,
    outputColorSpace: SRGBColorSpace,
    backend: { isWebGPUBackend: backend === 'webgpu' },
    getPixelRatio: () => 1,
    getDrawingBufferSize: (size: { set: (w: number, h: number) => unknown }) => size.set(128, 72),
  } as unknown as WebGPURenderer;
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const material = new MeshStandardMaterial();
  material.map = new Texture();
  scene.add(new Mesh(new BufferGeometry(), material));
  const options: PostChainOptions = {
    renderer,
    scene,
    camera,
    backend,
    tier: TIERS[tier],
    isTouch: false,
    requestFrame,
  };
  return options;
}

/** Drives the deterministic harness through one downgrade per 120 over-budget observations. */
function stepDown(chain: PostChain, steps: number): void {
  let now = 0;
  for (let step = 0; step < steps; step += 1) {
    for (let frame = 0; frame < 120; frame += 1) {
      chain.governorHarness?.observe(100, now += 100, false);
    }
  }
}

describe('post chain features record', () => {
  let requestFrame: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    requestFrame = vi.fn();
    vi.stubGlobal('location', { search: '' });
    vi.spyOn(performance, 'now').mockReturnValue(100_000);
    vi.spyOn(RenderPipeline.prototype, 'render').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reuses one record while nothing changes and pins the High rest content', () => {
    const chain = createPostChain(fixture('webgpu', 'high', requestFrame));

    const first = chain.features;
    expect(chain.features).toBe(first);
    expect(first).toEqual({
      ao: true,
      traa: true,
      msaa: false,
      ssgi: 'off',
      ssr: true,
      bloom: true,
      lut: true,
      vignette: true,
      dof: 'on',
    });
    chain.dispose();
  });

  it('hands out a new record for the motion window, the gate and their way back', () => {
    const chain = createPostChain(fixture('webgpu', 'high', requestFrame));
    const atRest = chain.features;

    chain.notifyMotion();
    const moving = chain.features;
    expect(moving).not.toBe(atRest);
    expect(moving.dof).toBe('ready');

    let clock = 100_000;
    vi.mocked(performance.now).mockImplementation(() => (clock += 1000));
    const rested = chain.features;
    expect(rested).not.toBe(moving);
    expect(rested.dof).toBe('on');

    chain.setDepthOfFieldAllowed(false);
    const gated = chain.features;
    expect(gated).not.toBe(rested);
    expect(gated.dof).toBe('off');

    chain.setDepthOfFieldAllowed(true);
    expect(chain.features).not.toBe(gated);
    expect(chain.features.dof).toBe('on');
    chain.dispose();
  });

  it('publishes fallback truth immediately from the next read', () => {
    const chain = createPostChain(fixture('webgpu', 'high', requestFrame));
    const before = chain.features;

    vi.mocked(RenderPipeline.prototype.render).mockImplementationOnce(() => {
      throw new Error('draw failed');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    chain.render();
    expect(chain.fellBack).toBe(true);

    const after = chain.features;
    expect(after).not.toBe(before);
    expect(after).toEqual({
      ao: false,
      traa: false,
      msaa: false,
      ssgi: 'off',
      ssr: false,
      bloom: false,
      lut: false,
      vignette: false,
      dof: 'off',
    });
    expect(chain.features).toBe(after);
    chain.dispose();
  });

  it('reflects a committed governor step in a new record after the render that applied it', () => {
    const chain = createPostChain(fixture('webgpu', 'high', requestFrame));
    const before = chain.features;

    stepDown(chain, 1);
    expect(chain.governorState?.level).toBe('no-ssr');
    chain.render();

    const after = chain.features;
    expect(after).not.toBe(before);
    expect(after.ssr).toBe(false);
    expect(after.bloom).toBe(true);
    expect(after.dof).toBe('on');
    chain.dispose();
  });

  it('gives two chains their own records and their own motion clock', () => {
    const first = createPostChain(fixture('webgpu', 'high', requestFrame));
    const second = createPostChain(fixture('webgpu', 'high', requestFrame));

    expect(first.features).not.toBe(second.features);

    first.notifyMotion();
    expect(first.features.dof).toBe('ready');
    expect(second.features.dof).toBe('on');
    expect(second.features).not.toBe(first.features);
    first.dispose();
    second.dispose();
  });
});

describe('post chain per-level settings derivation', () => {
  let requestFrame: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    requestFrame = vi.fn();
    vi.stubGlobal('location', { search: '' });
    vi.spyOn(performance, 'now').mockReturnValue(100_000);
    vi.spyOn(RenderPipeline.prototype, 'render').mockImplementation(() => undefined);
    mocked.settingsForLevel.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('derives each governor level once and reuses it across rendered frames', () => {
    const chain = createPostChain(fixture('webgpu', 'high', requestFrame));
    // Construction derives the starting level once; every render at that level reuses it.
    expect(mocked.settingsForLevel).toHaveBeenCalledTimes(1);
    chain.render();
    chain.render();
    expect(mocked.settingsForLevel).toHaveBeenCalledTimes(1);

    stepDown(chain, 1);
    chain.render();
    expect(mocked.settingsForLevel).toHaveBeenCalledTimes(2);
    for (let frame = 0; frame < 10; frame += 1) {
      chain.render();
    }
    expect(mocked.settingsForLevel).toHaveBeenCalledTimes(2);
    chain.dispose();
  });

  it('never shares derived settings between two chains', () => {
    const first = createPostChain(fixture('webgpu', 'high', requestFrame));
    stepDown(first, 2);
    first.render();
    expect(first.features.bloom).toBe(false);
    expect(first.features.dof).toBe('off');

    // A second chain sits one level higher: its derived settings are its own, so bloom and the
    // depth of field survive there even though the first chain sits below it at base.
    const second = createPostChain(fixture('webgpu', 'high', requestFrame));
    stepDown(second, 1);
    second.render();
    expect(second.features.bloom).toBe(true);
    expect(second.features.dof).toBe('on');
    expect(second.features.ssr).toBe(false);

    // Both keep their own state across interleaved renders.
    first.render();
    second.render();
    expect(first.features.bloom).toBe(false);
    expect(second.features.bloom).toBe(true);
    first.dispose();
    second.dispose();
  });
});
