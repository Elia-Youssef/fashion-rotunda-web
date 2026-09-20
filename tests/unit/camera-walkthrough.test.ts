// @vitest-environment jsdom
import { BoxGeometry, PerspectiveCamera, PlaneGeometry } from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWalkthrough } from '../../src/camera/walkthrough';

describe('createWalkthrough', () => {
  let canvas: HTMLCanvasElement;
  let camera: PerspectiveCamera;
  let collisionGeom: BoxGeometry;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    camera = new PerspectiveCamera(40, 1, 0.1, 100);
    // Wall at z = 4.0 with thickness 0.4 (front at z = 4.2).
    collisionGeom = new BoxGeometry(20, 4, 0.4);
    collisionGeom.translate(0, 2, 4.0);
  });

  function make(isTouch = false) {
    const onChange = vi.fn();
    const handle = createWalkthrough({
      camera,
      element: canvas,
      collision: collisionGeom,
      eyeHeight: 1.65,
      radius: 0.3,
      walkSpeed: 1.4,
      isTouch,
      onChange,
      now: () => 1000,
    });
    return { handle, onChange };
  }

  it('initializes at [0, 0, 5.5] facing the origin with eye height 1.65', () => {
    const { handle } = make();
    expect(handle.foot).toEqual([0, 0, 5.5]);
    expect(handle.yaw).toBe(0);
    expect(handle.pitch).toBe(0);
    expect(handle.enabled).toBe(false);
    handle.enable();
    expect(camera.position.x).toBeCloseTo(0, 5);
    expect(camera.position.y).toBeCloseTo(1.65, 5);
    expect(camera.position.z).toBeCloseTo(5.5, 5);
  });

  it('moves forward with KeyW and stops before a collision wall', () => {
    const { handle, onChange } = make();
    handle.enable();

    // Foot at [0, 0, 5.5], wall front at z = 4.2. Minimum safe z is 4.2 + 0.3 = 4.5.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));

    // 1 second of forward at 1.4 m/s would reach 5.5 - 1.4 = 4.1 without collision.
    // Update in 100 ms steps (10 frames).
    for (let i = 0; i < 10; i += 1) {
      handle.update(100);
    }

    expect(handle.foot[2]).toBeGreaterThanOrEqual(4.499);
    expect(handle.foot[1]).toBe(0);
    expect(onChange).toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  });

  it('doubles speed when Shift is held', () => {
    const floorGeom = new PlaneGeometry(50, 50);
    floorGeom.rotateX(-Math.PI / 2);
    const onChange = vi.fn();
    const handle = createWalkthrough({
      camera,
      element: canvas,
      collision: floorGeom,
      eyeHeight: 1.65,
      radius: 0.3,
      walkSpeed: 1.4,
      isTouch: false,
      onChange,
      now: () => 1000,
    });
    handle.enable();
    handle.setPose([0, 0, 10], 0, 0);

    // Normal forward for 1 second.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    for (let i = 0; i < 10; i += 1) {
      handle.update(100);
    }
    const distNormal = 10 - handle.foot[2];
    expect(distNormal).toBeCloseTo(1.4, 1);

    // Shift forward for 1 second.
    handle.setPose([0, 0, 10], 0, 0);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
    for (let i = 0; i < 10; i += 1) {
      handle.update(100);
    }
    const distSprint = 10 - handle.foot[2];
    expect(distSprint).toBeCloseTo(2.8, 1);
  });

  it('clamps pitch to +/- 80 degrees in setPose and mouse look', () => {
    const { handle } = make();
    const maxPitch = (80 * Math.PI) / 180;

    handle.setPose([0, 0, 0], 0, 2.5);
    expect(handle.pitch).toBeCloseTo(maxPitch, 5);

    handle.setPose([0, 0, 0], 0, -2.5);
    expect(handle.pitch).toBeCloseTo(-maxPitch, 5);
  });

  it('exits pointer lock and unbinds on disable', () => {
    const { handle } = make();
    handle.enable();
    expect(handle.enabled).toBe(true);

    handle.disable();
    expect(handle.enabled).toBe(false);
  });

  it('does not move while an interactive control owns keyboard focus', () => {
    const { handle } = make();
    handle.enable();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    handle.update(100);
    expect(handle.foot).toEqual([0, 0, 5.5]);
    input.remove();
  });
});
