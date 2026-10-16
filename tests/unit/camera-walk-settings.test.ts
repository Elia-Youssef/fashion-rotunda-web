// @vitest-environment jsdom
import { PerspectiveCamera } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readyWalkSession } from '../support/camera-walk-fixtures';
import type { WalkSession } from '../../src/camera/contracts';
import { WALK_EYE_HEIGHT, WALK_RADIUS, WALK_SPEED } from '../../src/camera/walk-settings';

// The walkthrough header documents three authored settings: a constant 1.65 m eye height, a
// 0.3 m capsule radius, and a 1.4 m/s pace that Shift doubles. The controller tests pass those
// numbers as literal options, so they would keep passing if the shared constants in
// src/camera/walk-settings.ts drifted. This file pins the constants themselves and what each
// drives through the real session wiring (createWalkSession passes them to createWalkthrough):
// the eye height above the floor after a walk pose is set, the clearance the capsule holds
// against a wall, and the distance covered in one second at walking pace and with Shift held.
// Behaviour already pinned elsewhere and not repeated here: the controller honours each option
// value (tests/unit/camera-walkthrough.test.ts, "initializes at [0, 0, 5.5] ...", "moves forward
// with KeyW and stops before a collision wall", "doubles speed when Shift is held", and the
// collision baselines), and the blended walk entry pose [0, 1.65, 5.5] built from
// WALK_EYE_HEIGHT in src/camera/mount.ts (tests/unit/camera-mount-ownership.test.ts, "cuts only after
// readiness under reduced motion and releases the animation hold").

let canvas: HTMLCanvasElement;
let camera: PerspectiveCamera;
let session: WalkSession | null = null;

beforeEach(() => {
  canvas = document.createElement('canvas');
  camera = new PerspectiveCamera(40, 1, 0.1, 100);
});

afterEach(() => {
  session?.dispose();
  session = null;
  canvas.remove();
});

function makeSession(): WalkSession {
  session = readyWalkSession({
    camera,
    canvas,
    isTouch: false,
    onChange: () => {},
    now: () => 1000,
  });
  return session;
}

function press(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code }));
}

function release(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { code }));
}

/** Walks forward for one simulated second in 100 ms steps; returns the distance covered. */
function walkForOneSecond(current: WalkSession): number {
  const startZ = current.walk.foot[2];
  for (let frame = 0; frame < 10; frame += 1) {
    current.walk.update(100);
  }
  return startZ - current.walk.foot[2];
}

describe('authored walk settings', () => {
  it('pins the walking eye height to 1.65 m', () => {
    expect(WALK_EYE_HEIGHT).toBe(1.65);
  });

  it('pins the capsule radius to 0.3 m', () => {
    expect(WALK_RADIUS).toBe(0.3);
  });

  it('pins the walking pace to 1.4 m per second', () => {
    expect(WALK_SPEED).toBe(1.4);
  });
});

describe('what the walk settings drive', () => {
  it('sets the camera eye 1.65 m above the floor when a walk pose is set', () => {
    const current = makeSession();
    current.walk.setPose([0.5, 0, 2], 0, 0);
    current.walk.enable();
    expect(current.walk.foot).toEqual([0.5, 0, 2]);
    expect(camera.position.x).toBeCloseTo(0.5, 9);
    expect(camera.position.y).toBeCloseTo(1.65, 9);
    expect(camera.position.z).toBeCloseTo(2, 9);
  });

  it('holds the capsule 0.3 m clear of a wall surface', () => {
    const current = makeSession();
    current.walk.enable();
    // The fixture wall front sits at z = 4.2, so the authored radius holds the foot at 4.5.
    press('KeyW');
    for (let frame = 0; frame < 10; frame += 1) {
      current.walk.update(100);
    }
    release('KeyW');
    expect(current.walk.foot[2]).toBeCloseTo(4.5, 4);
  });

  it('covers 1.4 m in one second at walking pace', () => {
    const current = makeSession();
    current.walk.enable();
    current.walk.setPose([0, 0, 10], 0, 0);
    press('KeyW');
    expect(walkForOneSecond(current)).toBeCloseTo(1.4, 6);
    release('KeyW');
  });

  it('covers 2.8 m in one second with Shift held', () => {
    const current = makeSession();
    current.walk.enable();
    current.walk.setPose([0, 0, 10], 0, 0);
    press('ShiftLeft');
    press('KeyW');
    expect(walkForOneSecond(current)).toBeCloseTo(2.8, 6);
    release('KeyW');
    release('ShiftLeft');
  });
});
