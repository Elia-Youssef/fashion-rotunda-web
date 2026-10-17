// Unit tests for capsule collision against MeshBVH.
// Verifies box wall push-out, cylinder plinth push-out, floor clamping, and input immutability.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  PlaneGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';

import { createCapsuleResolver, resolveCapsule } from '../../src/camera/collide';
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

// Surface contracts the recorded baseline does not reach: a surface the capsule body
// crosses (the closest points coincide, so the push direction must come from the
// triangle normal), a steep ramp (the push is flattened to its horizontal part), a
// triangle feature straight below the segment (the flattened difference is zero, so the
// push falls back to the normal's horizontal part) and a capsule shorter than its
// diameter (the segment top clamps to the bottom sphere center). Expected values were
// recorded from the committed resolver on 2026-10-16.
describe('resolveCapsule surfaces', () => {
  it('pushes a capsule down and away from a surface its body crosses', () => {
    // A segmented down-facing plane at y = 2.2 acts as a low ceiling. The default
    // capsule at foot y = 1.5 crosses it (segment y 1.8 to 2.85), so the closest
    // distance is about zero and the push direction must come from the triangle
    // normal: down and out of the surface band, never up through the surface and
    // never a no-push from a zeroed point difference. The plane is segmented so the
    // BVH has interior nodes: the traversal below the root consults the capsule's
    // query box, which must cover the whole segment, endpoints included, to reach
    // a ceiling this far above the segment's bottom point.
    const ceiling = new PlaneGeometry(4, 4, 8, 8);
    ceiling.rotateX(Math.PI / 2);
    ceiling.translate(0, 2.2, 0);
    const bvh = new MeshBVH(ceiling);

    const foot = new Vector3(0, 1.5, 0);
    const resolved = resolveCapsule(bvh, foot, DEFAULT_CAPSULE);

    expect(resolved.x).toBeCloseTo(0, 5);
    expect(resolved.z).toBeCloseTo(0, 5);
    expect(resolved.y).toBeLessThan(1.3);
    expect(resolved.y).toBeCloseTo(0.55, 3);
  });

  it('pushes out of a steep ramp horizontally, without lifting the foot', () => {
    // Ramp through [0, 0.5, 0] with normal (0, 0.5, 0.866): |normal.y| < 0.7, so the
    // push is flattened to its horizontal part. The foot height never changes; the
    // capsule slides away from the ramp face instead of riding up it.
    const ramp = new PlaneGeometry(4, 4);
    ramp.rotateX(-Math.PI / 6);
    ramp.translate(0, 0.5, 0);
    const bvh = new MeshBVH(ramp);

    const foot = new Vector3(0, 0.75, 0);
    const resolved = resolveCapsule(bvh, foot, DEFAULT_CAPSULE);

    expect(resolved.x).toBeCloseTo(0, 5);
    expect(resolved.y).toBeCloseTo(0.75, 10);
    expect(resolved.z).toBeGreaterThan(0.01);
    expect(resolved.z).toBeLessThan(0.05);
  });

  it('falls back to the horizontal triangle normal when the push flattens to zero', () => {
    // Steep triangle (normal (-0.9701, 0, 0.2425)) whose apex sits directly below the
    // segment's bottom point. The capsule-to-triangle direction is vertical, so after
    // the flatten it is the zero vector and the push must fall back to the normal's
    // horizontal part: the foot moves sideways away from the apex, height unchanged.
    // A resolver that normalizes the zero vector instead pushes nothing at all.
    const spike = new BufferGeometry();
    spike.setAttribute('position', new BufferAttribute(new Float32Array([
      0, 0, -1,
      0.5, 0, 1,
      0, 1, 0,
    ]), 3));
    const bvh = new MeshBVH(spike);

    const foot = new Vector3(0, 0.8, 0);
    const resolved = resolveCapsule(bvh, foot, DEFAULT_CAPSULE);

    expect(resolved.y).toBeCloseTo(0.8, 10);
    expect(resolved.x).toBeLessThan(-0.1);
    const horizontal = Math.hypot(resolved.x, resolved.z);
    expect(horizontal).toBeGreaterThan(0.15);
    expect(horizontal).toBeLessThan(0.35);
  });

  it('clamps a squat capsule segment to the bottom sphere center', () => {
    // Radius 1.0 with height 0.2: height is below the diameter, so the segment top
    // clamps to the bottom sphere center, one radius above the foot. The low block
    // sits just outside that sphere's reach (nearest point 1.082 away) and must not
    // push; an unclamped top offset of height - radius would drop the segment through
    // the block's band and push the capsule away.
    const block = new BoxGeometry(4, 0.4, 0.4);
    block.translate(0, 0.2, 2.3);
    const bvh = new MeshBVH(block);
    const squat: Capsule = { radius: 1.0, height: 0.2 };

    const foot = new Vector3(0, 0, 1.2);
    const resolved = resolveCapsule(bvh, foot, squat);

    expect(resolved.x).toBeCloseTo(0, 5);
    expect(resolved.y).toBeCloseTo(0, 5);
    expect(resolved.z).toBeCloseTo(1.2, 5);
  });

  it('treats a negative radius as radius zero', () => {
    // The radius clamp exists so a bad capsule cannot resolve anything: for any
    // negative radius no penetration test can fire and the returned foot must equal
    // the radius-zero result exactly. A dropped clamp routes foot.y through
    // (foot.y + radius) - radius, which does not round-trip exactly when the radius
    // is large relative to foot.y.
    const wallGeom = new BoxGeometry(10, 4, 0.4);
    wallGeom.translate(0, 2, 0);
    const bvh = new MeshBVH(wallGeom);
    const foot = new Vector3(0, 0.1, 0.3);

    const negative = resolveCapsule(bvh, foot, { radius: -1000, height: 1.65 });
    const zero = resolveCapsule(bvh, foot, { radius: 0, height: 1.65 });

    expect(negative.toArray()).toEqual(zero.toArray());
    expect(zero.toArray()).toEqual([0, 0.1, 0.3]);
  });
});

// Recorded from the resolver before its workspace became reusable (2026-10-10, working tree at
// cf5d4b8); the reusable workspace must reproduce every value exactly. Components are strings
// so the exact doubles, including negative zero, survive transcription; Number() decodes
// bit-exactly.
// Outcome tags recorded beside the values: 'free' leaves the input foot unchanged,
// 'held-at-wall' sits at the wall-face safe line (z >= 0.4999), 'floor-clamped' raises a
// below-floor foot to exactly 0, and 'pushed' marks a foot the resolver moved without
// claiming a geometric line (the deep and corner cases do not fully eject within
// MAX_ITERATIONS; their exact values are pinned above).
type Outcome = 'free' | 'held-at-wall' | 'floor-clamped' | 'pushed';

const BASELINE_CASES: Array<{
  id: string;
  geometry: 'wall' | 'plinth' | 'floor' | 'corner' | 'floorWall';
  foot: [number, number, number];
  capsule: Capsule;
  resolved: [string, string, string];
  outcome: Outcome[];
}> = [
  {
    id: 'wall-no-hit',
    geometry: 'wall',
    foot: [5, 0, 5],
    capsule: { radius: 0.3, height: 1.65 },
    resolved: ['5', '0', '5'],
    outcome: ['free'],
  },
  {
    id: 'wall-push',
    geometry: 'wall',
    foot: [0, 0, 0.3],
    capsule: { radius: 0.3, height: 1.65 },
    resolved: ['0', '0', '0.5000000029802323'],
    outcome: ['held-at-wall'],
  },
  {
    id: 'wall-deep',
    geometry: 'wall',
    foot: [0, 0, 0],
    capsule: { radius: 0.3, height: 1.65 },
    resolved: ['0', '0', '0.09999999701976772'],
    outcome: ['pushed'],
  },
  {
    id: 'floor-below',
    geometry: 'floor',
    foot: [0, -0.5, 2],
    capsule: { radius: 0.3, height: 1.65 },
    resolved: ['0', '0', '2'],
    outcome: ['floor-clamped'],
  },
  {
    id: 'plinth-push',
    geometry: 'plinth',
    foot: [0.7, 0, 0],
    capsule: { radius: 0.3, height: 1.65 },
    resolved: ['0.9165299993109647', '0', '0.24047267640219258'],
    outcome: ['pushed'],
  },
  {
    id: 'corner',
    geometry: 'corner',
    foot: [3.85, 0, 0.35],
    capsule: { radius: 0.3, height: 1.65 },
    resolved: ['4.099999952316284', '0', '0.5000000029802345'],
    outcome: ['pushed'],
  },
  {
    id: 'corner-deep',
    geometry: 'corner',
    foot: [3.95, 0, 0.05],
    capsule: { radius: 0.3, height: 1.65 },
    resolved: ['4.4999998092651365', '0', '-0.10132216137766623'],
    outcome: ['pushed'],
  },
  {
    id: 'floor-and-wall',
    geometry: 'floorWall',
    foot: [0, -0.2, 0.35],
    capsule: { radius: 0.3, height: 1.65 },
    resolved: ['0', '0', '0.5000000029802323'],
    outcome: ['floor-clamped', 'held-at-wall'],
  },
  {
    id: 'elevated-foot',
    geometry: 'wall',
    foot: [0, 0.8, 0.3],
    capsule: { radius: 0.3, height: 1.65 },
    resolved: ['1.776356918809592e-15', '0.8', '0.5000000029802323'],
    outcome: ['held-at-wall'],
  },
  {
    id: 'small-capsule',
    geometry: 'wall',
    foot: [0, 0, 0.3],
    capsule: { radius: 0.1, height: 1 },
    resolved: ['0', '0', '0.3'],
    outcome: ['free'],
  },
  {
    id: 'big-capsule',
    geometry: 'plinth',
    foot: [0.7, 0, 0],
    capsule: { radius: 0.45, height: 2.2 },
    resolved: ['1.0092420196485588', '0.000004943373162147324', '0.3629126765279119'],
    outcome: ['pushed'],
  },
  {
    id: 'far-negative',
    geometry: 'wall',
    foot: [-7, 0, -4],
    capsule: { radius: 0.3, height: 1.65 },
    resolved: ['-7', '0', '-4'],
    outcome: ['free'],
  },
];

function enc(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value);
}
function encComponents(v: Vector3): [string, string, string] {
  return [enc(v.x), enc(v.y), enc(v.z)];
}

// The same shapes the baseline was recorded against; a size or segment change here would
// silently invalidate the recorded values, so the builders mirror the recorder exactly.
function baselineGeometries(): Record<string, BufferGeometry> {
  const wall = new BoxGeometry(10, 4, 0.4);
  wall.translate(0, 2, 0);
  const plinth = new CylinderGeometry(0.65, 0.65, 0.3, 32);
  plinth.translate(0, 0.15, 0);
  const floor = new PlaneGeometry(20, 20);
  floor.rotateX(-Math.PI / 2);
  const wallA = new BoxGeometry(8, 3, 0.4);
  wallA.translate(0, 1.5, 0);
  const wallB = new BoxGeometry(0.4, 3, 8);
  wallB.translate(4, 1.5, 0);
  const corner = mergeGeometries([wallA, wallB]) as BufferGeometry;
  const floorWall = mergeGeometries([floor, wall]) as BufferGeometry;
  return { wall, plinth, floor, corner, floorWall };
}

describe('capsule resolver baseline', () => {
  it('reproduces every recorded case exactly through the reusable resolver', () => {
    const geoms = baselineGeometries();
    for (const expected of BASELINE_CASES) {
      const bvh = new MeshBVH(geoms[expected.geometry]);
      const foot = new Vector3(...expected.foot);
      const resolver = createCapsuleResolver(bvh, expected.capsule);

      const resolved = resolver.resolve(foot);

      expect(encComponents(resolved), expected.id).toEqual(expected.resolved);
      expect(foot.toArray(), expected.id).toEqual(expected.foot);
      expect(resolved.y, expected.id).toBeGreaterThanOrEqual(0);
    }
  });

  it('reproduces every recorded case exactly through the one-off call', () => {
    const geoms = baselineGeometries();
    for (const expected of BASELINE_CASES) {
      const bvh = new MeshBVH(geoms[expected.geometry]);
      const foot = new Vector3(...expected.foot);

      const resolved = resolveCapsule(bvh, foot, expected.capsule);

      expect(encComponents(resolved), expected.id).toEqual(expected.resolved);
    }
  });

  it('grounds every case and holds each recorded blocked outcome', () => {
    const geoms = baselineGeometries();
    for (const expected of BASELINE_CASES) {
      const bvh = new MeshBVH(geoms[expected.geometry]);
      const resolved = createCapsuleResolver(bvh, expected.capsule).resolve(
        new Vector3(...expected.foot),
      );

      // Grounded outcome, recorded for every case: no resolve returns a foot below the floor.
      expect(resolved.y, expected.id).toBeGreaterThanOrEqual(0);

      // Blocked outcome, recorded for every case: untouched, wall-face safe line, floor
      // clamp, or moved without a geometric pin.
      for (const outcome of expected.outcome) {
        if (outcome === 'free') {
          expect(resolved.toArray(), expected.id).toEqual(expected.foot);
        } else if (outcome === 'held-at-wall') {
          expect(resolved.z, expected.id).toBeGreaterThanOrEqual(0.4999);
        } else if (outcome === 'floor-clamped') {
          expect(resolved.y, expected.id).toBe(0);
        } else {
          expect(resolved.toArray(), expected.id).not.toEqual(expected.foot);
        }
      }
    }
  });

  it('writes a caller-supplied output vector and keeps the owned one separate', () => {
    const geoms = baselineGeometries();
    const bvh = new MeshBVH(geoms.wall);
    const resolver = createCapsuleResolver(bvh, DEFAULT_CAPSULE);
    const foot = new Vector3(0, 0, 0.3);
    const out = new Vector3();

    const returned = resolver.resolve(foot, out);

    expect(returned).toBe(out);
    expect(encComponents(out)).toEqual(['0', '0', '0.5000000029802323']);
    expect(foot.toArray()).toEqual([0, 0, 0.3]);
  });
});
