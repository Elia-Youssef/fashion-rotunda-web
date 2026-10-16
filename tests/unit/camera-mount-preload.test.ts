// @vitest-environment jsdom
import { performance as nodePerformance } from 'node:perf_hooks';
import { PerspectiveCamera } from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readyWalkLoader } from '../support/camera-walk-fixtures';
import type { CameraMount, mountCamera as mountType } from '../../src/camera/mount';

let cameraMount: typeof mountType;
let mark: () => void;
let createWalkLoad: typeof import('../../src/camera/walk-load').createWalkLoad;
let mounted: CameraMount | null;

beforeEach(async () => {
  vi.stubGlobal('performance', nodePerformance);
  nodePerformance.clearMarks('first-frame');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion') }));
  vi.resetModules();
  cameraMount = (await import('../../src/camera/mount')).mountCamera;
  mark = (await import('../../src/proof/marks')).markFirstFrame;
  createWalkLoad = (await import('../../src/camera/walk-load')).createWalkLoad;
  mounted = null;
});

afterEach(() => {
  mounted?.dispose();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nodePerformance.clearMarks('first-frame');
});

function make(isTouch = true, fail = false) {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const fetchCollision = vi.fn(async () => {
    if (fail) throw new Error('collision failed');
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
  });
  let loader: ReturnType<typeof createWalkLoad>;
  mounted = cameraMount({
    camera: new PerspectiveCamera(40, 1, 0.1, 100), canvas, isTouch,
    showroom: { setLookYaw: vi.fn(), lookYaw: 0 },
    loop: { invalidate: vi.fn(), setAnimating: vi.fn() },
    proofView: { position: [0, 1.7, 4.2], target: [0, 1, 0] }, views: {},
    collisionUrl: '/content/half/collision.glb', search: '?attract=0',
    createWalkLoader: (options) => {
      loader = createWalkLoad({ ...options, fetchCollision,
        importer: async () => ({ createWalkSession: () => {
          const session = readyWalkLoader(options).session!;
          vi.spyOn(session, 'loadCollision').mockResolvedValue();
          return session;
        } }) });
      vi.spyOn(loader, 'ensureReady');
      return loader;
    },
  });
  return { mount: mounted, fetchCollision, loader: loader! };
}

describe('collision preload scheduling', () => {
  it('requests no touch collision before the real first-frame mark and preloads once afterward', async () => {
    const { fetchCollision } = make();
    await vi.runAllTimersAsync();
    expect(fetchCollision).not.toHaveBeenCalled();
    mark();
    expect(fetchCollision).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(fetchCollision).toHaveBeenCalledOnce();
    mark();
    await vi.runAllTimersAsync();
    expect(fetchCollision).toHaveBeenCalledOnce();
  });

  it('preloads when a touch camera mounts after the first-frame mark', async () => {
    mark();
    const { fetchCollision } = make();
    await vi.runAllTimersAsync();
    expect(fetchCollision).toHaveBeenCalledOnce();
  });

  it('retains the eager desktop preload before the first-frame mark', async () => {
    const { fetchCollision } = make(false);
    await vi.runAllTimersAsync();
    expect(fetchCollision).toHaveBeenCalledOnce();
  });

  it('loads an explicit Walk request before first frame and does not duplicate it afterward', async () => {
    const { mount, fetchCollision } = make();
    const requested = mount.setMode('walk');
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCollision).toHaveBeenCalledOnce();
    await requested;
    expect(mount.mode).toBe('walk');
    mark();
    await vi.runAllTimersAsync();
    expect(fetchCollision).toHaveBeenCalledOnce();
  });

  it('does not retry an explicit failure when the first-frame mark arrives', async () => {
    const { mount, fetchCollision } = make(true, true);
    await expect(mount.setMode('walk')).rejects.toThrow('collision failed');
    expect(mount.mode).toBe('orbit');
    mark();
    await vi.runAllTimersAsync();
    expect(fetchCollision).toHaveBeenCalledOnce();
    expect(mount.walkLoadState).toBe('error');
  });

  it('cancels a pending touch preload when Orbit is explicitly selected', async () => {
    const { mount, fetchCollision } = make();
    await mount.setMode('orbit');
    mark();
    await vi.runAllTimersAsync();
    expect(fetchCollision).not.toHaveBeenCalled();
  });

  it.each(['before-mark', 'after-mark'] as const)('cancels on disposal %s', async (phase) => {
    const { mount, fetchCollision, loader } = make();
    if (phase === 'after-mark') mark();
    mount.dispose();
    if (phase === 'before-mark') mark();
    await vi.runAllTimersAsync();
    expect(fetchCollision).not.toHaveBeenCalled();
    expect(loader.ensureReady).not.toHaveBeenCalled();
  });
});
