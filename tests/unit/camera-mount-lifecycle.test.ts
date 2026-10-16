// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { canvas, make } from '../support/camera-mount';
import { createWalkLoad } from '../../src/camera/walk-load';

// Mount setup and teardown: the canvas attributes the mount owns and restores, the dev handle
// and dataset it publishes, the initial proof pose, disposal of what it created (including the
// collision fetch abort), and the pose memory that survives repeated mode switches.

describe('mountCamera', () => {
  it('aborts an in-flight collision request when disposed', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      () => new Promise<Response>(() => {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { mount: current } = make({ createWalkLoader: createWalkLoad });
    await vi.runAllTimersAsync();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    current.dispose();
    expect(init?.signal?.aborted).toBe(true);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it('starts the orbit at the proof view', () => {
    const { camera } = make();
    expect(camera.position.x).toBeCloseTo(0, 9);
    expect(camera.position.y).toBeCloseTo(1.7, 9);
    expect(camera.position.z).toBeCloseTo(4.2, 9);
  });

  it('sets touch-action none and a tab stop on the canvas, and restores both on dispose', () => {
    const { mount: current } = make();
    expect(canvas.style.touchAction).toBe('none');
    expect(canvas.tabIndex).toBe(0);
    current.dispose();
    expect(canvas.style.touchAction).toBe('');
    // The attribute is gone, not set to -1: a canvas that had no tabindex must end with none.
    expect(canvas.hasAttribute('tabindex')).toBe(false);
  });

  it('restores a tabindex the canvas already carried', () => {
    canvas.setAttribute('tabindex', '3');
    const { mount: current } = make();
    expect(canvas.tabIndex).toBe(0);
    current.dispose();
    expect(canvas.getAttribute('tabindex')).toBe('3');
  });

  it('disposes owned Walk input and touch controls through the camera mount', () => {
    const { mount: current } = make({ isTouch: true });
    const walk = current.walk!;
    walk.enable();
    expect(document.querySelector('.archviz-joystick-layer')).not.toBeNull();
    current.dispose();
    expect(walk.enabled).toBe(false);
    expect(document.querySelector('.archviz-joystick-layer')).toBeNull();
  });

  it('exposes window.archvizCamera in the dev build and removes it on dispose', () => {
    const { mount: current } = make();
    expect(window.archvizCamera?.orbit).toBe(current.orbit);
    expect(window.archvizCamera?.turntable).toBe(current.turntable);
    expect(window.archvizCamera?.walk).toBe(current.walk);
    expect(window.archvizCamera?.presets).toBe(current.presets);
    expect(window.archvizCamera?.attract).toBe(current.attract);
    expect(window.archvizCamera?.mode).toBe('orbit');
    expect(typeof window.archvizCamera?.setMode).toBe('function');
    current.dispose();
    expect(window.archvizCamera).toBeUndefined();
    expect(canvas.dataset.yaw).toBeUndefined();
  });

  it('sets dataset attributes for camera mode and attract', () => {
    const { mount: current } = make();
    expect(canvas.dataset.camera).toBe('orbit');
    expect(canvas.dataset.attract).toBe('0');
    current.dispose();
  });

  it('ten switches in a row end exactly where each mode was left', async () => {
    let currentTime = 1000;
    const { camera, mount: current } = make({
      now: () => currentTime,
    });

    const initialOrbitPos: [number, number, number] = [
      camera.position.x,
      camera.position.y,
      camera.position.z,
    ];
    const initialOrbitTarget: [number, number, number] = [
      current.orbit.target[0],
      current.orbit.target[1],
      current.orbit.target[2],
    ];

    // Modify walk pose when in walk mode to verify it remembers custom poses too
    const customWalkFoot: [number, number, number] = [1.2, 0, 3.4];
    const customWalkYaw = 0.5;
    const customWalkPitch = -0.2;

    // 10 switches total: 5 round trips (orbit -> walk -> orbit)
    for (let round = 0; round < 5; round += 1) {
      // 1. Switch to walk
      const walkPromise = current.setMode('walk');
      expect(current.moving).toBe(true);

      // Advance clock and frames across the 700 ms blend
      for (let t = 0; t < 10; t += 1) {
        currentTime += 100;
        current.update(100);
      }
      await walkPromise;

      expect(current.mode).toBe('walk');
      expect(canvas.dataset.camera).toBe('walk');

      if (round === 0) {
        // Initial walk pose default: [0, 0, 5.5]
        expect(current.walk!.foot[0]).toBeCloseTo(0, 5);
        expect(current.walk!.foot[1]).toBeCloseTo(0, 5);
        expect(current.walk!.foot[2]).toBeCloseTo(5.5, 5);
        // Move walk to custom pose
        current.walk!.setPose(customWalkFoot, customWalkYaw, customWalkPitch);
      } else {
        // Must restore where walk was left!
        expect(current.walk!.foot[0]).toBeCloseTo(customWalkFoot[0], 5);
        expect(current.walk!.foot[1]).toBeCloseTo(customWalkFoot[1], 5);
        expect(current.walk!.foot[2]).toBeCloseTo(customWalkFoot[2], 5);
        expect(current.walk!.yaw).toBeCloseTo(customWalkYaw, 5);
        expect(current.walk!.pitch).toBeCloseTo(customWalkPitch, 5);
      }

      // 2. Switch to orbit
      const orbitPromise = current.setMode('orbit');
      expect(current.moving).toBe(true);

      for (let t = 0; t < 10; t += 1) {
        currentTime += 100;
        current.update(100);
      }
      await orbitPromise;

      expect(current.mode).toBe('orbit');
      expect(canvas.dataset.camera).toBe('orbit');

      // Orbit must be restored to initial orbit pose exactly!
      expect(current.orbit.position[0]).toBeCloseTo(initialOrbitPos[0], 5);
      expect(current.orbit.position[1]).toBeCloseTo(initialOrbitPos[1], 5);
      expect(current.orbit.position[2]).toBeCloseTo(initialOrbitPos[2], 5);
      expect(current.orbit.target[0]).toBeCloseTo(initialOrbitTarget[0], 5);
      expect(current.orbit.target[1]).toBeCloseTo(initialOrbitTarget[1], 5);
      expect(current.orbit.target[2]).toBeCloseTo(initialOrbitTarget[2], 5);
    }
  });
});
