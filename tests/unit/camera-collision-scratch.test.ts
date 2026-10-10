// @vitest-environment jsdom
// Scratch reuse on the collision path. The module mock swaps in counting subclasses of the
// three.js math classes, so a warm resolve or walking step that builds a vector, segment or box
// fails the count; identity checks prove the callbacks and the owned output vector are the same
// instances across steps; and the blocked-then-free case proves no state leaks between steps.

import { BoxGeometry, CylinderGeometry, PerspectiveCamera, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it, vi } from 'vitest';

import { createCapsuleResolver } from '../../src/camera/collide';
import type { Capsule } from '../../src/camera/collide';
import { createWalkthrough } from '../../src/camera/walkthrough';

const constructed = vi.hoisted(() => ({ Vector3: 0, Line3: 0, Box3: 0 }));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class CountingVector3 extends actual.Vector3 {
    constructor(...args: ConstructorParameters<typeof actual.Vector3>) {
      constructed.Vector3 += 1;
      super(...args);
    }
  }
  class CountingLine3 extends actual.Line3 {
    constructor(...args: ConstructorParameters<typeof actual.Line3>) {
      constructed.Line3 += 1;
      super(...args);
    }
  }
  class CountingBox3 extends actual.Box3 {
    constructor(...args: ConstructorParameters<typeof actual.Box3>) {
      constructed.Box3 += 1;
      super(...args);
    }
  }
  return { ...actual, Vector3: CountingVector3, Line3: CountingLine3, Box3: CountingBox3 };
});

function resetCounts(): void {
  constructed.Vector3 = 0;
  constructed.Line3 = 0;
  constructed.Box3 = 0;
}

function expectNoConstructions(): void {
  expect(constructed).toEqual({ Vector3: 0, Line3: 0, Box3: 0 });
}

const CAPSULE: Capsule = { radius: 0.3, height: 1.65 };

function wallGeometry(): BufferGeometry {
  const wall = new BoxGeometry(10, 4, 0.4);
  wall.translate(0, 2, 0);
  return wall;
}

function plinthGeometry(): BufferGeometry {
  const plinth = new CylinderGeometry(0.65, 0.65, 0.3, 32);
  plinth.translate(0, 0.15, 0);
  return plinth;
}

// A position that penetrates the wall and one far from every surface.
const BLOCKED = new Vector3(0, 0, 0.3);
const FREE = new Vector3(5, 0, 5);

describe('capsule resolver scratch', () => {
  it('a warm resolve constructs no vector, segment or box', () => {
    const bvh = new MeshBVH(wallGeometry());
    const resolver = createCapsuleResolver(bvh, CAPSULE);

    // Warm-up: the BVH and the library pools grow on their first use only.
    resolver.resolve(BLOCKED);
    resolver.resolve(FREE);
    resetCounts();

    for (let i = 0; i < 10; i += 1) {
      resolver.resolve(BLOCKED);
      resolver.resolve(FREE);
    }

    expectNoConstructions();
  });

  it('every shapecast call receives the same callback record and functions', () => {
    const bvh = new MeshBVH(wallGeometry());
    const resolver = createCapsuleResolver(bvh, CAPSULE);
    const captured: Array<{ record: object; bounds: unknown; triangle: unknown }> = [];
    const original = bvh.shapecast;
    const spy = vi.spyOn(bvh, 'shapecast').mockImplementation((record) => {
      captured.push({
        record,
        bounds: record.intersectsBounds,
        triangle: record.intersectsTriangle,
      });
      return original.call(bvh, record);
    });

    resolver.resolve(BLOCKED);
    resolver.resolve(new Vector3(0, 0, 0));
    spy.mockRestore();

    // One shapecast call per resolution iteration; both resolves iterate.
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const entry of captured) {
      expect(entry.record).toBe(captured[0].record);
      expect(entry.bounds).toBe(captured[0].bounds);
      expect(entry.triangle).toBe(captured[0].triangle);
    }
  });

  it('reuses the owned output vector and keeps a caller-supplied one separate', () => {
    const bvh = new MeshBVH(wallGeometry());
    const resolver = createCapsuleResolver(bvh, CAPSULE);

    const first = resolver.resolve(BLOCKED);
    expect(first.toArray()).toEqual([0, 0, 0.5000000029802323]);

    const second = resolver.resolve(FREE);
    expect(second).toBe(first);
    expect(second.toArray()).toEqual([5, 0, 5]);

    const out = new Vector3();
    const returned = resolver.resolve(BLOCKED, out);
    expect(returned).toBe(out);
    expect(out.toArray()).toEqual([0, 0, 0.5000000029802323]);
  });

  it('a free resolve after a blocked one traverses and resolves as if run alone', () => {
    // Two walls, no floor: a multi-leaf BVH where the solo free resolve prunes every node,
    // while the wall box alone would be one leaf whose triangles are always tested.
    const front = new BoxGeometry(20, 3, 0.4);
    front.translate(0, 1.5, -2);
    const side = new BoxGeometry(0.4, 3, 20);
    side.translate(2.8, 1.5, 0);
    const bvh = new MeshBVH(mergeGeometries([front, side]) as BufferGeometry);
    const resolver = createCapsuleResolver(bvh, CAPSULE);
    const cornerFoot = new Vector3(2.5, 0, -1.7);

    // Solo reference from a fresh workspace.
    const soloFree = createCapsuleResolver(bvh, CAPSULE).resolve(FREE).toArray();

    // Count triangle visits by wrapping the callback on the way through.
    let triangleVisits = 0;
    let counting = false;
    const original = bvh.shapecast;
    const spy = vi.spyOn(bvh, 'shapecast').mockImplementation((record) => {
      const triangle = record.intersectsTriangle;
      if (!counting || triangle === undefined) {
        return original.call(bvh, record);
      }
      return original.call(bvh, {
        ...record,
        intersectsTriangle: (tri, index, contained, depth) => {
          triangleVisits += 1;
          return triangle(tri, index, contained, depth);
        },
      });
    });

    resolver.resolve(cornerFoot);
    counting = true;
    const afterBlocked = resolver.resolve(FREE);
    spy.mockRestore();

    // A solo run prunes every node before any triangle test; stale workspace bounds would
    // still reach the walls' triangles here.
    expect(triangleVisits).toBe(0);
    expect(afterBlocked.toArray()).toEqual(soloFree);
  });

  it('interleaved resolvers keep independent workspaces', () => {
    // The resolvers differ in every input a shared workspace could leak: different BVHs and
    // different capsules, since a workspace can hold its capsule's derived constants. A fresh
    // resolver is only a valid reference while workspaces are per-instance, so the
    // wide-capsule reference is the value recorded from the per-instance implementation (the
    // 'big-capsule' case in camera-collide.test.ts); the committed code resolves it exactly.
    const wallBvh = new MeshBVH(wallGeometry());
    const plinthBvh = new MeshBVH(plinthGeometry());
    const wideCapsule: Capsule = { radius: 0.45, height: 2.2 };
    const wallResolver = createCapsuleResolver(wallBvh, CAPSULE);
    const plinthResolver = createCapsuleResolver(plinthBvh, wideCapsule);
    const plinthFoot = new Vector3(0.7, 0, 0);

    wallResolver.resolve(BLOCKED);
    const fromPlinthResolver = plinthResolver.resolve(plinthFoot).toArray();
    const fromWallResolver = wallResolver.resolve(BLOCKED).toArray();

    // The wall reference from a fresh resolver alone.
    const soloWall = createCapsuleResolver(wallBvh, CAPSULE).resolve(BLOCKED).toArray();
    expect(fromWallResolver).toEqual(soloWall);
    expect(fromPlinthResolver).toEqual([
      1.0092420196485588,
      0.000004943373162147324,
      0.3629126765279119,
    ]);
  });

  it('a resolve nested between the iterations of another leaves both unchanged', () => {
    // A stub BVH runs a full plinth resolve between every shapecast of the wall resolve, so
    // the plinth resolver runs while the wall resolver's workspace state is live. A workspace
    // shared by the two would return the wall resolver with plinth state in it.
    const wallBvh = new MeshBVH(wallGeometry());
    const plinthBvh = new MeshBVH(plinthGeometry());
    const plinthResolver = createCapsuleResolver(plinthBvh, CAPSULE);
    const plinthFoot = new Vector3(0.7, 0, 0);
    const stub = {
      shapecast(callbacks: Parameters<MeshBVH['shapecast']>[0]): boolean {
        plinthResolver.resolve(plinthFoot);
        return wallBvh.shapecast(callbacks);
      },
    };
    const wallResolver = createCapsuleResolver(stub as unknown as MeshBVH, CAPSULE);

    // Solo references from fresh workspaces.
    const soloWall = createCapsuleResolver(wallBvh, CAPSULE).resolve(BLOCKED).toArray();
    const soloPlinth = createCapsuleResolver(plinthBvh, CAPSULE).resolve(plinthFoot).toArray();

    const nestedWall = wallResolver.resolve(BLOCKED).toArray();
    const lastPlinth = plinthResolver.resolve(plinthFoot).toArray();

    expect(nestedWall).toEqual(soloWall);
    expect(lastPlinth).toEqual(soloPlinth);
  });
});

describe('walkthrough scratch', () => {
  it('a warm walking step constructs no vector, segment or box', () => {
    const wall = new BoxGeometry(20, 4, 0.4);
    wall.translate(0, 2, 4.0);
    const handle = createWalkthrough({
      camera: new PerspectiveCamera(40, 1, 0.1, 100),
      element: document.createElement('canvas'),
      collision: wall,
      eyeHeight: 1.65,
      radius: 0.3,
      walkSpeed: 1.4,
      isTouch: false,
      onChange: () => {},
      now: () => 1000,
    });
    handle.enable();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));

    // Warm-up: the BVH and the library pools grow on their first use only.
    handle.update(100);
    handle.update(100);
    resetCounts();

    for (let i = 0; i < 10; i += 1) {
      handle.update(100);
    }

    expectNoConstructions();

    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    handle.disable();
  });
});
