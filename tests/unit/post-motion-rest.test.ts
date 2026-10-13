import { AgXToneMapping, BufferGeometry, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, SRGBColorSpace, Texture } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostChain } from '../../src/post/chain';
import type { PostChainOptions } from '../../src/post/chain';
import type { Backend } from '../../src/post/settings';
import { TIERS } from '../../src/tiers/table';
// The motion-rest callback of the post chain. Every moving frame used to cancel and re-register a
// native timer; the chain now owns one stable callback that re-arms itself at the remaining rest
// deadline, and arms nothing at all when no live depth-of-field graph exists to redraw. The timer
// constants here are the chain's: 500 ms of motion window plus the 10 ms arming margin.

const REST_DELAY_MS = 510;

/** Minimal fake timers: the chain only needs setTimeout, clearTimeout and firing in time order. */
class FakeTimers {
  now = 0;
  registrations = 0;
  fired = 0;
  private nextId = 1;
  private pending = new Map<number, { runAt: number; fn: () => void }>();

  setTimeout = (fn: () => void, ms: number): number => {
    this.registrations += 1;
    const id = this.nextId;
    this.nextId += 1;
    this.pending.set(id, { runAt: this.now + ms, fn });
    return id;
  };

  clearTimeout = (id: number): void => {
    this.pending.delete(id);
  };

  /** Advances the clock, firing every due callback in time order, re-entrancy included. */
  advance(ms: number): void {
    const deadline = this.now + ms;
    for (;;) {
      let earliest: { id: number; runAt: number; fn: () => void } | null = null;
      for (const [id, entry] of this.pending) {
        if (entry.runAt <= deadline && (earliest === null || entry.runAt < earliest.runAt)) {
          earliest = { id, runAt: entry.runAt, fn: entry.fn };
        }
      }
      if (earliest === null) {
        break;
      }
      this.pending.delete(earliest.id);
      this.now = earliest.runAt;
      this.fired += 1;
      earliest.fn();
    }
    this.now = deadline;
  }
}

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

describe('post chain motion rest', () => {
  let timers: FakeTimers;
  let requestFrame: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    timers = new FakeTimers();
    requestFrame = vi.fn();
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('window', timers);
    vi.spyOn(performance, 'now').mockImplementation(() => timers.now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('arms one timer for a whole motion burst and redraws once at the true rest deadline', () => {
    const chain = createPostChain(fixture('webgpu', 'high', requestFrame));

    chain.notifyMotion();
    expect(timers.registrations).toBe(1);

    // A moving frame arms nothing while the callback holds the deadline.
    for (let step = 0; step < 31; step += 1) {
      timers.advance(16);
      chain.notifyMotion();
    }
    expect(timers.now).toBe(496);
    expect(timers.registrations).toBe(1);
    expect(requestFrame).not.toHaveBeenCalled();

    // The callback keeps firing and re-arming while the burst runs; a 1.5 s burst costs a handful
    // of registrations, not one per frame, and never redraws while the camera still moves.
    for (let step = 0; step < 94; step += 1) {
      timers.advance(16);
      chain.notifyMotion();
    }
    expect(timers.now).toBe(2000);
    expect(timers.registrations).toBeLessThan(10);
    expect(requestFrame).not.toHaveBeenCalled();

    // Motion stops: exactly one redraw, exactly at the last notice plus the rest delay.
    const lastMotion = timers.now;
    timers.advance(REST_DELAY_MS - 1);
    expect(requestFrame).not.toHaveBeenCalled();
    timers.advance(1);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(timers.now).toBe(lastMotion + REST_DELAY_MS);
    timers.advance(1000);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    chain.dispose();
  });

  it('re-arms at the remaining deadline when motion lands after arming', () => {
    const chain = createPostChain(fixture('webgpu', 'high', requestFrame));

    chain.notifyMotion();
    timers.advance(500);
    chain.notifyMotion();
    expect(timers.registrations).toBe(1);

    // The armed callback fires 10 ms later, finds motion 500 ms young and re-arms once.
    timers.advance(10);
    expect(timers.fired).toBe(1);
    expect(timers.registrations).toBe(2);
    expect(requestFrame).not.toHaveBeenCalled();

    timers.advance(500);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(timers.now).toBe(1010);
    chain.dispose();
  });

  it('arms nothing on a graph without a live depth-of-field node', () => {
    const base = createPostChain(fixture('webgpu', 'base', requestFrame));
    const webgl2 = createPostChain(fixture('webgl2', 'high', requestFrame));

    for (let step = 0; step < 10; step += 1) {
      base.notifyMotion();
      webgl2.notifyMotion();
      timers.advance(16);
    }
    expect(timers.registrations).toBe(0);
    expect(timers.fired).toBe(0);
    timers.advance(2000);
    expect(requestFrame).not.toHaveBeenCalled();

    base.dispose();
    webgl2.dispose();
  });

  it('skips the redraw when the depth-of-field gate is closed at the deadline', () => {
    const chain = createPostChain(fixture('webgpu', 'high', requestFrame));

    chain.notifyMotion();
    chain.setDepthOfFieldAllowed(false);
    requestFrame.mockClear();
    timers.advance(REST_DELAY_MS + 10);
    expect(timers.fired).toBe(1);
    expect(requestFrame).not.toHaveBeenCalled();
    chain.dispose();
  });

  it('serves the mode switch back to orbit: the gate reopening before the deadline still redraws', () => {
    const chain = createPostChain(fixture('webgpu', 'high', requestFrame));

    // Last motion in walkthrough mode: the graph is live, the gate is closed, the callback arms.
    chain.setDepthOfFieldAllowed(false);
    chain.notifyMotion();
    expect(timers.registrations).toBe(1);

    timers.advance(100);
    chain.setDepthOfFieldAllowed(true);
    requestFrame.mockClear();

    timers.advance(REST_DELAY_MS - 100);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    chain.dispose();
  });

  it('cancels the pending callback on disposal and ignores later notices', () => {
    const chain = createPostChain(fixture('webgpu', 'high', requestFrame));

    chain.notifyMotion();
    expect(timers.registrations).toBe(1);
    chain.dispose();
    chain.notifyMotion();
    timers.advance(2000);
    expect(timers.fired).toBe(0);
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('keeps every motion timestamp: the features read ready while moving and on after rest', () => {
    timers.now = 100_000;
    const chain = createPostChain(fixture('webgpu', 'high', requestFrame));

    chain.notifyMotion();
    expect(chain.features.dof).toBe('ready');

    // The motion window is strict: 499 ms after the notice is still moving, 500 ms is rest.
    timers.now = 100_000 + 499;
    expect(chain.features.dof).toBe('ready');
    timers.now = 100_000 + 500;
    expect(chain.features.dof).toBe('on');
    chain.dispose();
  });

  it('gives each chain its own callback and timer state', () => {
    const first = createPostChain(fixture('webgpu', 'high', requestFrame));
    const second = createPostChain(fixture('webgpu', 'high', requestFrame));

    first.notifyMotion();
    second.notifyMotion();
    expect(timers.registrations).toBe(2);
    // Disposing the first chain cancels only its own armed callback.
    first.dispose();
    timers.advance(REST_DELAY_MS + 10);
    expect(timers.fired).toBe(1);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    second.dispose();
  });
});
