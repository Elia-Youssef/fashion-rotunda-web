// @vitest-environment jsdom
import { BoxGeometry, Group, Mesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';

import { readyWalkLoader, readyWalkSession } from '../support/camera-walk-fixtures';
import { canvas, make, pointer, PROOF_VIEW } from '../support/camera-mount';
import { createWalkLoad } from '../../src/camera/walk-load';
import type { WalkLoader, WalkLoadState, WalkSession } from '../../src/camera/contracts';
import type { CameraMount } from '../../src/camera/mount';

// Asynchronous camera ownership: the Walk handover that waits on the collision load, and the
// pending promises, live Orbit input, blends and tour it must hold or settle while it waits.

function deferredLoader() {
  let ready!: (value: WalkSession | null) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<WalkSession | null>((resolve, reject) => { ready = resolve; fail = reject; });
  let state: WalkLoadState = 'loading';
  let session: WalkSession | null = null;
  const listeners = new Set<() => void>();
  const loader: WalkLoader = {
    get state() { return state; },
    get session() { return state === 'ready' ? session : null; },
    ensureReady: vi.fn(() => promise),
    // Deliberately permit a late completion: the coordinator must guard intent independently.
    cancel: vi.fn(),
    onStateChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    dispose: vi.fn(() => session?.dispose()),
  };
  const factory = vi.fn((options: Parameters<typeof readyWalkSession>[0]) => {
    session = readyWalkSession(options);
    return loader;
  });
  return {
    loader, factory,
    ready() { state = 'ready'; listeners.forEach((listener) => listener()); ready(session); },
    fail() { state = 'error'; listeners.forEach((listener) => listener()); fail(new Error('load failed')); },
  };
}

function finishBlend(current: CameraMount): void {
  for (let frame = 0; frame < 7; frame += 1) current.update(100);
}

describe('asynchronous camera ownership', () => {
  it('keeps the queued boot preload but cancels it on disposal before any attempt', async () => {
    vi.useFakeTimers();
    try {
      const factory = vi.fn(readyWalkLoader);
      const { mount: current } = make({ createWalkLoader: factory });
      const loader = factory.mock.results[0].value;
      expect(loader.ensureReady).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(loader.ensureReady).toHaveBeenCalledOnce();
      current.dispose();
      const second = make({ createWalkLoader: factory }).mount;
      second.dispose();
      await vi.runAllTimersAsync();
      expect(factory.mock.results[1].value.ensureReady).not.toHaveBeenCalled();
      expect(window.archvizCamera).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('does not turn the queued preload into an automatic retry after an explicit failure', async () => {
    vi.useFakeTimers();
    try {
      const loading = deferredLoader();
      const { mount: current } = make({ createWalkLoader: loading.factory });
      const rejected = expect(current.setMode('walk')).rejects.toThrow('load failed');
      loading.fail();
      await rejected;
      await vi.runAllTimersAsync();
      expect(loading.loader.ensureReady).toHaveBeenCalledOnce();
      expect(current.mode).toBe('orbit');
      expect(current.walkLoadState).toBe('error');
    } finally { vi.useRealTimers(); }
  });

  it('prevents collision-free movement while the actual collision parser is pending', async () => {
    let parsed!: (gltf: GLTF) => void;
    let entered!: () => void;
    const parsing = new Promise<void>((resolve) => { entered = resolve; });
    const parser = vi.spyOn(GLTFLoader.prototype, 'parse').mockImplementation((_data, _path, done) => {
      parsed = done;
      entered();
    });
    try {
      const { mount: current } = make({
        search: '?attract=0',
        createWalkLoader: (options) => createWalkLoad({ ...options, fetchCollision: vi.fn(async () => ({
          ok: true, arrayBuffer: async () => new ArrayBuffer(0),
        } as Response)) }),
      });
      const loading = current.setMode('walk');
      await parsing;
      await Promise.resolve();
      await Promise.resolve();
      finishBlend(current);
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      for (let frame = 0; frame < 10; frame += 1) current.update(100);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
      // A premature placeholder handover crosses the wall before the real parser finishes.
      expect(current.walk?.foot[2] ?? 5.5).toBeGreaterThanOrEqual(4.499);
      expect(current.mode).toBe('orbit');
      const scene = new Group();
      scene.add(new Mesh(new BoxGeometry(20, 4, 0.4).translate(0, 2, 4)));
      parsed({ scene } as GLTF);
      await Promise.resolve();
      await Promise.resolve();
      finishBlend(current);
      await loading;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      for (let frame = 0; frame < 10; frame += 1) current.update(100);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
      expect(current.walk!.foot[2]).toBeLessThan(5.5);
      expect(current.walk!.foot[2]).toBeGreaterThanOrEqual(4.499);
    } finally { parser.mockRestore(); }
  });

  it('keeps a pending promise and live Orbit input until collision is ready, then captures the live pose', async () => {
    const loading = deferredLoader();
    const { mount: current, camera, loop } = make({ createWalkLoader: loading.factory, search: '?attract=0' });
    const changed = vi.fn();
    current.onModeChange(changed);
    let completed = false;
    const promise = current.setMode('walk');
    void promise.then(() => { completed = true; });
    expect(current.setMode('walk')).toBe(promise);
    expect(loading.loader.ensureReady).toHaveBeenCalledOnce();
    finishBlend(current);
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(current.mode).toBe('orbit');
    expect(canvas.dataset.camera).toBe('orbit');
    expect(current.walk).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
    expect(loop.setAnimating).not.toHaveBeenCalledWith(true);
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 240, 100);
    pointer('pointerup', 240, 100);
    current.orbit.setPose([2, 2, 4], [0, 1, 0]);
    const live = camera.position.toArray();
    loading.ready();
    await Promise.resolve();
    expect(camera.position.toArray()).toEqual(live);
    expect(current.mode).toBe('orbit');
    expect(current.walk?.enabled).toBe(false);
    finishBlend(current);
    await promise;
    expect(current.mode).toBe('walk');
    expect(current.walk?.enabled).toBe(true);
    expect(changed).toHaveBeenCalledExactlyOnceWith('walk');
    const returning = current.setMode('orbit');
    finishBlend(current);
    await returning;
    expect(camera.position.x).toBeCloseTo(live[0], 9);
    expect(camera.position.y).toBeCloseTo(live[1], 9);
    expect(camera.position.z).toBeCloseTo(live[2], 9);
    expect(current.moving).toBe(false);
    expect(loop.setAnimating).toHaveBeenLastCalledWith(false);
  });

  it('cancels Walk while still in Orbit and ignores a late ready completion', async () => {
    const loading = deferredLoader();
    const { mount: current, camera } = make({ createWalkLoader: loading.factory, search: '?attract=0' });
    const changed = vi.fn();
    current.onModeChange(changed);
    const walk = current.setMode('walk');
    await current.setMode('orbit');
    await walk;
    const before = camera.position.toArray();
    loading.ready();
    await Promise.resolve();
    finishBlend(current);
    expect(current.mode).toBe('orbit');
    expect(camera.position.toArray()).toEqual(before);
    expect(current.walk?.enabled).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(loading.loader.cancel).toHaveBeenCalledOnce();
    expect(current.pendingMode).toBeNull();
  });

  it('reverses interrupted blends from the live pose and settles superseded requests', async () => {
    const { mount: current, camera, loop } = make({ search: '?attract=0' });
    const changed = vi.fn();
    current.onModeChange(changed);
    const walk = current.setMode('walk');
    current.update(100);
    const midpoint = camera.position.toArray();
    const orbit = current.setMode('orbit');
    await walk;
    expect(camera.position.toArray()).toEqual(midpoint);
    current.update(100);
    expect(camera.position.z).toBeLessThan(midpoint[2]);
    expect(camera.position.z).toBeGreaterThan(PROOF_VIEW.position[2]);
    const again = current.setMode('walk');
    await orbit;
    finishBlend(current);
    await again;
    expect(current.mode).toBe('walk');
    expect(changed).toHaveBeenCalledExactlyOnceWith('walk');
    expect(loop.setAnimating).toHaveBeenLastCalledWith(false);
  });

  it('cuts only after readiness under reduced motion and releases the animation hold', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    try {
      const loading = deferredLoader();
      const { mount: current, camera, loop } = make({ createWalkLoader: loading.factory });
      const promise = current.setMode('walk');
      expect(current.mode).toBe('orbit');
      loading.ready();
      await Promise.resolve();
      expect(current.mode).toBe('walk');
      expect(camera.position.toArray()).toEqual([0, 1.65, 5.5]);
      await promise;
      expect(current.walk?.enabled).toBe(true);
      expect(loop.setAnimating).not.toHaveBeenCalledWith(true);
      expect(current.moving).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it('rejects an active failure while Orbit keeps its pose and input', async () => {
    const loading = deferredLoader();
    const { mount: current, camera } = make({ createWalkLoader: loading.factory });
    const before = camera.position.toArray();
    const promise = current.setMode('walk');
    const rejected = expect(promise).rejects.toThrow('load failed');
    loading.fail();
    await rejected;
    expect(current.mode).toBe('orbit');
    expect(current.pendingMode).toBeNull();
    expect(camera.position.toArray()).toEqual(before);
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 240, 100);
    expect(camera.position.x).not.toBeCloseTo(before[0], 6);
  });

  it.each(['loading', 'blend'] as const)('settles disposal during %s without late camera writes', async (stage) => {
    const loading = deferredLoader();
    const onDispose = vi.fn();
    const { mount: current, camera, loop } = make({ createWalkLoader: loading.factory, onDispose });
    const promise = current.setMode('walk');
    if (stage === 'blend') { loading.ready(); await Promise.resolve(); current.update(100); }
    current.dispose();
    current.dispose();
    await promise;
    const before = camera.position.toArray();
    loading.ready();
    await Promise.resolve();
    finishBlend(current);
    expect(camera.position.toArray()).toEqual(before);
    expect(window.archvizCamera).toBeUndefined();
    expect(canvas.dataset.camera).toBeUndefined();
    expect(loading.loader.dispose).toHaveBeenCalledOnce();
    expect(onDispose).toHaveBeenCalledOnce();
    if (stage === 'blend') expect(loop.setAnimating).toHaveBeenLastCalledWith(false);
  });

  it('suspends an active tour while waiting and resets its idle clock on completion', async () => {
    let now = 1000;
    const loading = deferredLoader();
    const { mount: current, camera, loop } = make({
      createWalkLoader: loading.factory, search: '?attract=1&attractIdle=100', now: () => now,
      views: { proof: { ...PROOF_VIEW, fov: 40 }, entrance: {
        position: [0, 2.2, 6.2], target: [0, 1, 0], fov: 45,
      } },
    });
    now += 200;
    current.update(0);
    expect(canvas.dataset.attract).toBe('1');
    const promise = current.setMode('walk');
    now += 5000;
    const before = camera.position.toArray();
    current.update(0);
    expect(canvas.dataset.attract).toBe('0');
    expect(camera.position.toArray()).toEqual(before);
    expect(loop.setAnimating).toHaveBeenLastCalledWith(false);
    await current.setMode('orbit');
    await promise;
    current.update(0);
    expect(canvas.dataset.attract).toBe('0');
  });
});
