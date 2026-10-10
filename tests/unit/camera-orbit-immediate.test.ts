// @vitest-environment jsdom
// The synchronous immediate pose paths (placeAt, setPose): exact results against recorded
// values, moveTo semantics, and the allocation contract the per-frame callers rely on: no
// Vector3, no Spherical and no promise constructed per call. three/webgpu is mocked with
// counting subclasses so the construction claim is measured, not assumed.
import { createHook } from 'node:async_hooks';

import { PerspectiveCamera } from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOrbit } from '../../src/camera/orbit';
import type { OrbitHandle, OrbitLimits } from '../../src/camera/orbit';
import golden from '../fixtures/camera-pose-golden.json';

const constructed = vi.hoisted(() => ({ vector3: 0, spherical: 0 }));

vi.mock('three/webgpu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three/webgpu')>();
  class CountedVector3 extends actual.Vector3 {
    constructor(x?: number, y?: number, z?: number) {
      super(x, y, z);
      constructed.vector3 += 1;
    }
  }
  class CountedSpherical extends actual.Spherical {
    constructor(radius?: number, phi?: number, theta?: number) {
      super(radius, phi, theta);
      constructed.spherical += 1;
    }
  }
  return { ...actual, Vector3: CountedVector3, Spherical: CountedSpherical };
});

const TARGET: [number, number, number] = [0, 1, 0];
const LIMITS: OrbitLimits = {
  minDistance: 1.2,
  maxDistance: 7,
  minPolar: 0.15,
  maxPolar: Math.PI / 2 - 0.05,
};

let mounted: { element: HTMLElement; orbit: OrbitHandle }[] = [];

beforeEach(() => {
  mounted = [];
});

afterEach(() => {
  while (mounted.length > 0) {
    const current = mounted.pop();
    if (current === undefined) {
      continue;
    }
    current.orbit.dispose();
    current.element.remove();
  }
});

function make(): { orbit: OrbitHandle; camera: PerspectiveCamera } {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const camera = new PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 1.7, 4.2);
  camera.lookAt(...TARGET);
  const orbit = createOrbit({
    camera,
    element,
    target: TARGET,
    limits: LIMITS,
    damping: 0.12,
    onChange: () => {},
  });
  mounted.push({ element, orbit });
  return { orbit, camera };
}

/** Counts promises constructed while `run` executes, synchronously. */
function countPromises(run: () => void): number {
  let created = 0;
  const hook = createHook({
    init(_asyncId, type) {
      if (type === 'PROMISE') {
        created += 1;
      }
    },
  });
  hook.enable();
  try {
    run();
  } finally {
    hook.disable();
  }
  return created;
}

function asTuple(values: number[]): [number, number, number] {
  return [values[0], values[1], values[2]];
}

describe('orbit immediate pose paths', () => {
  it('replays the recorded placeAt, setPose and reset results exactly', () => {
    // Each fixture row ran against the pre-change code: moveTo through the promise-returning
    // glide path, setPose through fresh vectors. The numbers must round-trip exactly.
    for (const row of golden.orbitImmediate) {
      const { orbit } = make();
      const position = asTuple(row.position);
      if (row.kind === 'moveTo') {
        if (row.fov === null) {
          orbit.placeAt(position, TARGET);
        } else {
          orbit.placeAt(position, TARGET, row.fov);
        }
      } else if (row.fov === null) {
        orbit.setPose(position, TARGET);
      } else {
        orbit.setPose(position, TARGET, row.fov);
      }
      expect(orbit.position).toEqual(row.after.position);
      expect(orbit.target).toEqual(row.after.target);
      expect(orbit.fov).toBe(row.after.fov);
      orbit.reset();
      expect(orbit.position).toEqual(row.afterReset.position);
      expect(orbit.target).toEqual(row.afterReset.target);
      expect(orbit.fov).toBe(row.afterReset.fov);
    }
  });

  it('placeAt keeps moveTo semantics: reset still returns to the built-in pose', () => {
    const { orbit } = make();
    orbit.placeAt([2, 1.6, 3], TARGET, 50);
    expect(orbit.position[0]).toBeCloseTo(2, 9);
    expect(orbit.fov).toBe(50);
    orbit.reset();
    expect(orbit.position[0]).toBeCloseTo(0, 9);
    expect(orbit.position[1]).toBeCloseTo(1.7, 9);
    expect(orbit.position[2]).toBeCloseTo(4.2, 9);
    // reset() restores the pose, not the fov: the same held value a zero-ms glide left behind.
    expect(orbit.fov).toBe(50);
  });

  it('placeAt reads its inputs before returning, so one tuple can feed every tick', () => {
    const { orbit } = make();
    const tuple: [number, number, number] = [1, 2, 3];
    orbit.placeAt(tuple, TARGET);
    const firstReading = [...orbit.position];
    tuple[0] = -1;
    tuple[1] = 1.5;
    tuple[2] = 2;
    orbit.placeAt(tuple, TARGET);
    expect(firstReading[0]).toBeCloseTo(1, 9);
    expect(firstReading[1]).toBeCloseTo(2, 9);
    expect(firstReading[2]).toBeCloseTo(3, 9);
    expect(orbit.position[0]).toBeCloseTo(-1, 9);
    expect(orbit.position[1]).toBeCloseTo(1.5, 9);
    expect(orbit.position[2]).toBeCloseTo(2, 9);
  });

  it('placeAt and setPose construct no Vector3, Spherical or promise', () => {
    const { orbit } = make();
    constructed.vector3 = 0;
    constructed.spherical = 0;
    const promises = countPromises(() => {
      orbit.placeAt([1, 2, 3], [0, 1, 0], 45);
      orbit.setPose([0, 1.7, 4.2], [0, 1, 0]);
      orbit.placeAt([-2, 1.5, 1], [0, 1.2, 0]);
      orbit.placeAt([1, 2, 3], [0, 1, 0]);
    });
    expect(constructed.vector3).toBe(0);
    expect(constructed.spherical).toBe(0);
    expect(promises).toBe(0);
  });

  it('the promise and construction detectors see the allocating glide path', () => {
    // Control for the zero-allocation claim above: the same detectors must fire on the path
    // that does allocate, or the zero readings would prove nothing.
    const { orbit } = make();
    constructed.vector3 = 0;
    constructed.spherical = 0;
    const promises = countPromises(() => {
      void orbit.glideTo([1, 2, 3], [0, 1, 0], 0);
    });
    expect(promises).toBeGreaterThan(0);
    expect(constructed.vector3).toBeGreaterThan(0);
    expect(constructed.spherical).toBeGreaterThan(0);
  });
});
