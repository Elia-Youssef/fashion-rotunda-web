// @vitest-environment jsdom
import { PerspectiveCamera } from 'three/webgpu';
import type { Vector3 } from 'three/webgpu';
import { afterEach, expect, it, vi } from 'vitest';

import { createOrbit } from '../../src/camera/orbit';
import type { OrbitHandle } from '../../src/camera/orbit';

const workspace = vi.hoisted(() => ({ constructed: 0, receivers: new Set<object>() }));
vi.mock('three/webgpu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three/webgpu')>();
  class CountedVector3 extends actual.Vector3 {
    constructor(x?: number, y?: number, z?: number) {
      super(x, y, z);
      workspace.constructed += 1;
    }
    override lerpVectors(a: Vector3, b: Vector3, alpha: number): this {
      workspace.receivers.add(this);
      return super.lerpVectors(a, b, alpha);
    }
  }
  return { ...actual, Vector3: CountedVector3 };
});

const controls: OrbitHandle[] = [];
afterEach(() => {
  for (const control of controls) control.dispose();
  controls.length = 0;
  workspace.receivers.clear();
});

function make() {
  const camera = new PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 2, 4);
  const orbit = createOrbit({
    camera,
    element: document.createElement('div'),
    target: [0, 1, 0],
    limits: { minDistance: 1, maxDistance: 10, minPolar: 0.1, maxPolar: 1.5 },
    damping: 0.12,
    onChange: () => {},
  });
  controls.push(orbit);
  return { camera, orbit };
}

it('reuses two glide vectors across updates and interruptions with unchanged FOV and landing', async () => {
  const { orbit, camera } = make();
  const first = orbit.glideTo([2, 3, 4], [1, 1, 0], 1000, 60);
  const before = workspace.constructed;
  orbit.update(250);
  expect(orbit.position[0]).toBeCloseTo(0.125, 12);
  expect(orbit.target[0]).toBe(0.0625);
  expect(camera.fov).toBe(41.25);
  orbit.update(250);
  expect(orbit.position[0]).toBeCloseTo(1, 12);
  expect(orbit.target[0]).toBe(0.5);
  expect(camera.fov).toBe(50);
  expect(workspace.constructed).toBe(before);
  const receivers = [...workspace.receivers];
  expect(receivers).toHaveLength(2);
  const second = orbit.glideTo([-2, 2, 3], [-1, 1, 0], 1000, 30);
  await first;
  const afterSetup = workspace.constructed;
  orbit.update(500);
  expect(orbit.position[0]).toBeCloseTo(-0.5, 12);
  expect(orbit.target[0]).toBe(-0.25);
  expect(camera.fov).toBe(40);
  orbit.update(500);
  await second;
  expect(orbit.position[0]).toBeCloseTo(-2, 12);
  expect(orbit.position[1]).toBeCloseTo(2, 12);
  expect(orbit.position[2]).toBeCloseTo(3, 12);
  expect(orbit.target).toEqual([-1, 1, 0]);
  expect(camera.fov).toBe(30);
  expect(orbit.moving).toBe(false);
  expect(workspace.constructed).toBe(afterSetup);
  expect([...workspace.receivers]).toEqual(receivers);
});

it('keeps glide scratch independent between interleaved orbit instances', async () => {
  const a = make().orbit;
  const b = make().orbit;
  const first = a.glideTo([2, 3, 4], [1, 1, 0], 1000, 60);
  const second = b.glideTo([-2, 2, 3], [-1, 1, 0], 1000, 30);
  a.update(250);
  const firstWorkspace = new Set(workspace.receivers);
  workspace.receivers.clear();
  b.update(500);
  expect(workspace.receivers.size).toBe(2);
  for (const receiver of workspace.receivers) expect(firstWorkspace.has(receiver)).toBe(false);
  expect(a.position[0]).toBeCloseTo(0.125, 12);
  expect(b.position[0]).toBeCloseTo(-1, 12);
  a.update(750);
  b.update(500);
  await Promise.all([first, second]);
  expect(a.target).toEqual([1, 1, 0]);
  expect(b.target).toEqual([-1, 1, 0]);
  expect(a.fov).toBe(60);
  expect(b.fov).toBe(30);
});
