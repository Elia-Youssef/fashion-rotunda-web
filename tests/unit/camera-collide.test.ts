// Unit tests for capsule collision against MeshBVH.
// Verifies box wall push-out, cylinder plinth push-out, floor clamping, and input immutability.

import { BoxGeometry, CylinderGeometry, PlaneGeometry, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';

import { resolveCapsule } from '../../src/camera/collide';
import type { Capsule } from '../../src/camera/collide';

const DEFAULT_CAPSULE: Capsule = {
  radius: 0.3,
  height: 1.65,
};

describe('resolveCapsule', () => {
  it('does not mutate the input vector', () => {
    const geom = new BoxGeometry(2, 2, 2);
    const bvh = new MeshBVH(geom);
    const foot = new Vector3(0, 0, 0.5);
    const x = foot.x;
    const y = foot.y;
    const z = foot.z;

    resolveCapsule(bvh, foot, DEFAULT_CAPSULE);

    expect(foot.x).toBe(x);
    expect(foot.y).toBe(y);
    expect(foot.z).toBe(z);
  });

  it('pushes a capsule out of a box wall', () => {
    // Wall of width 10, height 4, thickness 0.4 centered at [0, 2, 0].
    // Front face sits at z = 0.2.
    const wallGeom = new BoxGeometry(10, 4, 0.4);
    wallGeom.translate(0, 2, 0);
    const bvh = new MeshBVH(wallGeom);

    // Foot placed at z = 0.3: with radius 0.3, it penetrates into the wall by 0.2.
    const foot = new Vector3(0, 0, 0.3);
    const resolved = resolveCapsule(bvh, foot, DEFAULT_CAPSULE);

    // Front face is at z = 0.2, so foot center must be at least z = 0.2 + 0.3 = 0.5.
    expect(resolved.z).toBeGreaterThanOrEqual(0.499);
    expect(resolved.x).toBeCloseTo(0, 5);
    expect(resolved.y).toBeCloseTo(0, 5);
  });

  it('pushes a capsule out of a cylinder (the plinth)', () => {
    // Plinth of radius 0.65 m, height 0.3 m resting on the floor [0, 0.15, 0].
    const plinthGeom = new CylinderGeometry(0.65, 0.65, 0.3, 32);
    plinthGeom.translate(0, 0.15, 0);
    const bvh = new MeshBVH(plinthGeom);

    // Foot placed at [0.7, 0, 0]: distance to plinth center is 0.7.
    // Minimum safe distance is plinth radius (0.65) + capsule radius (0.3) = 0.95.
    const foot = new Vector3(0.7, 0, 0);
    const resolved = resolveCapsule(bvh, foot, DEFAULT_CAPSULE);

    const dist = Math.hypot(resolved.x, resolved.z);
    // A 32-segment cylinder has facet chord midpoint distance 0.65 * cos(pi/32) = 0.6468,
    // plus radius 0.3 = 0.9468.
    expect(dist).toBeGreaterThanOrEqual(0.94);
    expect(resolved.y).toBeCloseTo(0, 5);
  });

  it('never pushes a capsule below the floor', () => {
    // Floor plane at y = 0.
    const floorGeom = new PlaneGeometry(20, 20);
    floorGeom.rotateX(-Math.PI / 2);
    const bvh = new MeshBVH(floorGeom);

    // Foot initially below the floor.
    const foot = new Vector3(0, -0.5, 2);
    const resolved = resolveCapsule(bvh, foot, DEFAULT_CAPSULE);

    expect(resolved.y).toBeGreaterThanOrEqual(0);
    expect(resolved.y).toBeCloseTo(0, 4);
  });

  it('leaves a capsule alone when far from any geometry', () => {
    const wallGeom = new BoxGeometry(1, 1, 1);
    wallGeom.translate(0, 0.5, 0);
    const bvh = new MeshBVH(wallGeom);

    const foot = new Vector3(5, 0, 5);
    const resolved = resolveCapsule(bvh, foot, DEFAULT_CAPSULE);

    expect(resolved.x).toBeCloseTo(5, 5);
    expect(resolved.y).toBeCloseTo(0, 5);
    expect(resolved.z).toBeCloseTo(5, 5);
  });
});
