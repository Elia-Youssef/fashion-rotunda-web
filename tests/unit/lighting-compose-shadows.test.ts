// Shadow assignment must keep transmissive dome panes out of the sun shadow map.

import { Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';

import { enableShadows } from '../../src/lighting/compose';

describe('enableShadows', () => {
  it('lets a transmission-only material receive the sun without casting a black pane shadow', () => {
    const root = new Group();
    const glass = new MeshPhysicalMaterial({ transmission: 1 });
    glass.transparent = false;
    const domePane = new Mesh(undefined, glass);
    const marble = new Mesh(undefined, new MeshStandardMaterial());
    root.add(domePane, marble);

    enableShadows(root);

    expect(domePane.castShadow).toBe(false);
    expect(domePane.receiveShadow).toBe(true);
    expect(marble.castShadow).toBe(true);
    expect(marble.receiveShadow).toBe(true);
  });

  it('treats a mesh with no material as opaque and still gives it the sun shadow', () => {
    const mesh = { isMesh: true, castShadow: false, receiveShadow: false, material: null };
    enableShadows({ traverse: (callback) => callback(mesh) });

    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
  });

  it('leaves a mesh that lacks the shadow properties untouched', () => {
    const bare = { isMesh: true, castShadow: false, receiveShadow: false };
    enableShadows({ traverse: (callback) => callback(bare) });

    expect(bare.castShadow).toBe(false);
    expect(bare.receiveShadow).toBe(false);
  });

  it('never casts from a material group that contains any transparent material', () => {
    const transmissive = new MeshPhysicalMaterial({ transmission: 1 });
    transmissive.transparent = false;
    const mixed = new Mesh(undefined, [new MeshStandardMaterial(), transmissive]);
    const solid = new Mesh(undefined, [new MeshStandardMaterial(), new MeshStandardMaterial()]);
    enableShadows({ traverse: (callback) => { callback(mixed); callback(solid); } });

    expect(mixed.castShadow).toBe(false);
    expect(mixed.receiveShadow).toBe(true);
    expect(solid.castShadow).toBe(true);
    expect(solid.receiveShadow).toBe(true);
  });
});
