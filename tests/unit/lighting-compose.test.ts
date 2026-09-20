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
});
