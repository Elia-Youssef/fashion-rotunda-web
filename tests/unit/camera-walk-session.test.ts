// @vitest-environment jsdom
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Mesh, PerspectiveCamera } from 'three';
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
  it.each(['parse', 'missing', 'empty'] as const)('rejects %s collision without readiness', async (kind) => {
    const current = make();
    const ready = vi.fn();
    current.onReady(ready);
    if (kind === 'parse') {
      vi.mocked(GLTFLoader.prototype.parse).mockImplementationOnce((_data, _path, _done, fail) => {
        fail!(new ErrorEvent('error', { message: 'invalid GLB' }));
      });
    }
    const loading = current.loadCollision(new ArrayBuffer(0), new AbortController().signal);
    const rejected = kind === 'parse' ? expect(loading).rejects.toMatchObject({ message: 'invalid GLB' })
      : expect(loading).rejects.toThrow('no triangles');
    const geometry = new BufferGeometry();
    const disposeGeometry = vi.spyOn(geometry, 'dispose');
    if (kind === 'empty') parsed(geometry);
    if (kind === 'missing') finishParse!({ scene: new Group() } as GLTF);
    await rejected;
    expect(current.ready).toBe(false);
    expect(ready).not.toHaveBeenCalled();
    if (kind === 'empty') expect(disposeGeometry).toHaveBeenCalledOnce();
  });

  it('publishes readiness only after real collision and preserves the private transitional pose', async () => {
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
    const loading = current.loadCollision(new ArrayBuffer(0), new AbortController().signal);
    expect(current.ready).toBe(false);

    // Front wall surface z=4.2 plus capsule radius 0.3 holds the foot at z=4.5.
    const wall = new BoxGeometry(20, 4, 0.4).translate(0, 2, 4);
    parsed(wall);
    await loading;
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
    const current = make({ isTouch: true, onChange });
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
    const loading = current.loadCollision(new ArrayBuffer(0), new AbortController().signal);
    const failed = expect(loading).rejects.toThrow('collision controller failed');
    const geometry = new BoxGeometry();
    const disposeGeometry = vi.spyOn(geometry, 'dispose');
    const failure = new Error('collision controller failed');
    vi.spyOn(walkthroughModule, 'createWalkthrough').mockImplementationOnce(() => { throw failure; });
    parsed(geometry);
    await failed;
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(current.walk).toBe(previous);
    expect(current.ready).toBe(false);
    expect(ready).not.toHaveBeenCalled();
  });

  it('disposes a late parsed geometry without publishing readiness', async () => {
    const current = make();
    const ready = vi.fn();
    current.onReady(ready);
    const loading = current.loadCollision(new ArrayBuffer(0), new AbortController().signal);
    const canceled = expect(loading).rejects.toThrow('Walk load canceled');
    current.dispose();
    await canceled;
    const geometry = new BoxGeometry();
    const disposeGeometry = vi.spyOn(geometry, 'dispose');
    parsed(geometry);
    expect(current.ready).toBe(false);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(current.walk.enabled).toBe(false);
    expect(ready).not.toHaveBeenCalled();
  });

  it('carries the live pose into the replacement collision controller', async () => {
    const current = make();
    current.walk.setPose([1.25, 0, 3.5], 1.2, 0.1);
    const ready = vi.fn();
    current.onReady(ready);
    const loading = current.loadCollision(new ArrayBuffer(0), new AbortController().signal);
    parsed(new BoxGeometry(20, 4, 0.4).translate(0, 2, 4));
    await loading;
    expect(current.walk.foot).toEqual([1.25, 0, 3.5]);
    expect(current.walk.yaw).toBe(1.2);
    expect(current.walk.pitch).toBe(0.1);
    expect(ready).toHaveBeenCalledOnce();
  });

  it('rejects a precanceled load without starting a parse', async () => {
    const current = make();
    const lifetime = new AbortController();
    lifetime.abort();
    await expect(current.loadCollision(new ArrayBuffer(0), lifetime.signal))
      .rejects.toThrow('Walk load canceled');
    expect(finishParse).toBeUndefined();
    expect(current.ready).toBe(false);
  });

  it('rejects and releases parsed meshes when the signal aborts mid-parse', async () => {
    const current = make();
    const previous = current.walk;
    const ready = vi.fn();
    current.onReady(ready);
    const lifetime = new AbortController();
    const loading = current.loadCollision(new ArrayBuffer(0), lifetime.signal);
    lifetime.abort();
    const canceled = expect(loading).rejects.toThrow('Walk load canceled');
    const wall = new BoxGeometry(20, 4, 0.4).translate(0, 2, 4);
    const disposeWall = vi.spyOn(wall, 'dispose');
    parsed(wall);
    await canceled;
    expect(current.ready).toBe(false);
    expect(ready).not.toHaveBeenCalled();
    expect(current.walk).toBe(previous);
    expect(disposeWall).toHaveBeenCalledOnce();
  });

  it('rejects an indexed collision whose index counts fewer than three corners', async () => {
    const current = make();
    const ready = vi.fn();
    current.onReady(ready);
    const loading = current.loadCollision(new ArrayBuffer(0), new AbortController().signal);
    const stub = new BufferGeometry();
    stub.setAttribute('position', new Float32BufferAttribute(
      [0, 0, 0, 4, 0, 0, 0, 0, 4, 1, 1, 1], 3,
    ));
    stub.setIndex([0, 1]);
    parsed(stub);
    await expect(loading).rejects.toThrow('no triangles');
    expect(current.ready).toBe(false);
    expect(ready).not.toHaveBeenCalled();
  });

  it('accepts a single-triangle indexed collision mesh', async () => {
    const current = make();
    const ready = vi.fn();
    current.onReady(ready);
    const loading = current.loadCollision(new ArrayBuffer(0), new AbortController().signal);
    const triangle = new BufferGeometry();
    triangle.setAttribute('position', new Float32BufferAttribute(
      [0, 0, 0, 4, 0, 0, 0, 0, 4], 3,
    ));
    triangle.setIndex([0, 1, 2]);
    parsed(triangle);
    await loading;
    expect(current.ready).toBe(true);
    expect(ready).toHaveBeenCalledOnce();
  });

  it('rejects when the collision parser throws synchronously', async () => {
    const current = make();
    vi.mocked(GLTFLoader.prototype.parse).mockImplementationOnce(() => {
      throw new Error('parse threw');
    });
    await expect(current.loadCollision(new ArrayBuffer(0), new AbortController().signal))
      .rejects.toThrow('parse threw');
    expect(current.ready).toBe(false);
  });

  it('places the touch layer over the canvas rect and follows window resize', () => {
    const rect = vi.spyOn(canvas, 'getBoundingClientRect');
    rect.mockReturnValue({ left: 11, top: 22, width: 333, height: 444 } as DOMRect);
    make({ isTouch: true });
    const layer = document.querySelector<HTMLElement>('.archviz-joystick-layer')!;
    const read = () => [layer.style.left, layer.style.top, layer.style.width, layer.style.height];
    expect(read()).toEqual(['11px', '22px', '333px', '444px']);
    rect.mockReturnValue({ left: 5, top: 6, width: 77, height: 88 } as DOMRect);
    window.dispatchEvent(new Event('resize'));
    expect(read()).toEqual(['5px', '6px', '77px', '88px']);
  });
});
