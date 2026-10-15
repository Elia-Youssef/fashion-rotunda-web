// @vitest-environment jsdom
import { BoxGeometry, BufferGeometry, Group, Mesh, PerspectiveCamera } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WalkSession, WalkSessionOptions } from '../../src/camera/contracts';
import * as joystickModule from '../../src/camera/joystick';
import { createWalkSession } from '../../src/camera/walk-session';
import * as walkthroughModule from '../../src/camera/walkthrough';

let canvas: HTMLCanvasElement;
let session: WalkSession | null;
let finishParse: ((gltf: GLTF) => void) | undefined;
const observe = vi.fn();
const disconnect = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  observe.mockReset();
  disconnect.mockReset();
  vi.stubGlobal('ResizeObserver', class {
    observe = observe;
    disconnect = disconnect;
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(0),
  })));
  finishParse = undefined;
  vi.spyOn(GLTFLoader.prototype, 'parse').mockImplementation((_data, _path, onLoad) => {
    finishParse = onLoad;
  });
  canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  session = null;
});

afterEach(() => {
  session?.dispose();
  document.querySelectorAll('.archviz-joystick-layer').forEach((element) => element.remove());
  canvas.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function make(options: Partial<WalkSessionOptions> = {}): WalkSession {
  session = createWalkSession({
    camera: new PerspectiveCamera(40, 1, 0.1, 100),
    canvas,
    collisionUrl: '/content/collision.glb',
    isTouch: false,
    onChange: vi.fn(),
    now: () => 1000,
    ...options,
  });
  return session;
}

function parsed(geometry: BufferGeometry): void {
  if (finishParse === undefined) throw new Error('collision parse has not started');
  const scene = new Group();
  scene.add(new Mesh(geometry));
  finishParse({ scene } as GLTF);
}

describe('createWalkSession', () => {
  it('keeps eager preload, readiness, pose and colliding controller replacement', async () => {
    const disposeGeometry = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const current = make();
    const previous = current.walk;
    previous.setPose([0, 0, 5.5], 0, 0);
    previous.enable();
    const disposePrevious = vi.spyOn(previous, 'dispose');
    const ready = vi.fn();
    current.onReady(ready);
    const unsubscribed = vi.fn();
    current.onReady(unsubscribed)();

    expect(current.ready).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/content/collision.glb', {
      signal: expect.any(AbortSignal),
    });
    expect(current.ready).toBe(false);

    // Front wall surface z=4.2 plus capsule radius 0.3 holds the foot at z=4.5.
    const wall = new BoxGeometry(20, 4, 0.4).translate(0, 2, 4);
    parsed(wall);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(current.walk).not.toBe(previous);
    expect(disposePrevious).toHaveBeenCalledOnce();
    expect(current.walk.enabled).toBe(true);
    expect(current.walk.foot).toEqual([0, 0, 5.5]);
    expect(current.walk.yaw).toBe(0);
    expect(current.walk.pitch).toBe(0);
    expect(current.ready).toBe(true);
    expect(ready).toHaveBeenCalledOnce();
    expect(unsubscribed).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    for (let frame = 0; frame < 10; frame += 1) current.walk.update(100);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    expect(current.walk.foot[2]).toBeLessThan(5.5);
    expect(current.walk.foot[2]).toBeGreaterThanOrEqual(4.499);
    current.dispose();
    current.dispose();
    expect(disposeGeometry.mock.contexts.filter((geometry) => geometry === wall)).toHaveLength(1);
  });

  it('disposes active input, touch DOM, observer and geometry exactly once', () => {
    const disposeGeometry = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const onChange = vi.fn();
    const current = make({ isTouch: true, collisionUrl: '', onChange });
    const walk = current.walk;
    const disposeWalk = vi.spyOn(walk, 'dispose');
    const vector = vi.spyOn(walk, 'setJoystickVector');
    const rect = vi.spyOn(canvas, 'getBoundingClientRect');
    const base = document.querySelector<HTMLElement>('.archviz-joystick-base')!;
    expect(base).not.toBeNull();
    current.setJoystickVisible(true);
    expect(base.parentElement?.hidden).toBe(false);
    walk.enable();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    current.dispose();
    current.dispose();

    expect(walk.enabled).toBe(false);
    expect(disposeWalk).toHaveBeenCalledOnce();
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(document.querySelector('.archviz-joystick-layer')).toBeNull();
    const foot = walk.foot;
    vector.mockClear();
    onChange.mockClear();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    base.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 20, clientY: 20 }));
    window.dispatchEvent(new Event('resize'));
    expect(vector).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(rect).not.toHaveBeenCalled();
    expect(walk.update(100)).toBe(false);
    expect(walk.foot).toEqual(foot);
  });

  it('rolls back placeholder geometry when initial controller construction throws', () => {
    const disposeGeometry = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const failure = new Error('controller construction failed');
    vi.spyOn(walkthroughModule, 'createWalkthrough').mockImplementationOnce(() => { throw failure; });
    expect(() => make({ isTouch: true })).toThrow(failure);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(document.querySelector('.archviz-joystick-layer')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rolls back controller, layer and observer when joystick construction throws', () => {
    const controller = vi.spyOn(walkthroughModule, 'createWalkthrough');
    const failure = new Error('joystick construction failed');
    vi.spyOn(joystickModule, 'mountJoystick').mockImplementationOnce(() => { throw failure; });
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const rect = vi.spyOn(canvas, 'getBoundingClientRect');
    const disposeGeometry = vi.spyOn(BufferGeometry.prototype, 'dispose');
    expect(() => make({ isTouch: true })).toThrow(failure);
    const partialWalk = controller.mock.results[0].value;
    expect(partialWalk.enabled).toBe(false);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(canvas);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeWindow).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(document.querySelector('.archviz-joystick-layer')).toBeNull();
    rect.mockClear();
    window.dispatchEvent(new Event('resize'));
    expect(rect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rolls back layer registrations when observer setup throws', () => {
    const failure = new Error('observer setup failed');
    observe.mockImplementationOnce(() => { throw failure; });
    const rect = vi.spyOn(canvas, 'getBoundingClientRect');
    expect(() => make({ isTouch: true })).toThrow(failure);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(document.querySelector('.archviz-joystick-layer')).toBeNull();
    rect.mockClear();
    window.dispatchEvent(new Event('resize'));
    expect(rect).not.toHaveBeenCalled();
  });

  it('rolls back failed collision construction without publishing readiness', async () => {
    const current = make();
    const previous = current.walk;
    const ready = vi.fn();
    current.onReady(ready);
    await vi.runAllTimersAsync();
    const geometry = new BoxGeometry();
    const disposeGeometry = vi.spyOn(geometry, 'dispose');
    const failure = new Error('collision controller failed');
    vi.spyOn(walkthroughModule, 'createWalkthrough').mockImplementationOnce(() => { throw failure; });
    expect(() => parsed(geometry)).toThrow(failure);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(current.walk).toBe(previous);
    expect(current.ready).toBe(false);
    expect(ready).not.toHaveBeenCalled();
  });

  it('cancels a queued preload and aborts an in-flight fetch', async () => {
    const queued = make();
    queued.dispose();
    await vi.runAllTimersAsync();
    expect(fetch).not.toHaveBeenCalled();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      () => new Promise<Response>(() => {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    const current = make();
    await vi.runAllTimersAsync();
    const signal = fetchMock.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    current.dispose();
    expect(signal?.aborted).toBe(true);
  });

  it('disposes a late parsed geometry without publishing readiness', async () => {
    const current = make();
    const ready = vi.fn();
    current.onReady(ready);
    await vi.runAllTimersAsync();
    current.dispose();
    const geometry = new BoxGeometry();
    const disposeGeometry = vi.spyOn(geometry, 'dispose');
    parsed(geometry);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(current.ready).toBe(false);
    expect(current.walk.enabled).toBe(false);
    expect(ready).not.toHaveBeenCalled();
  });
});
