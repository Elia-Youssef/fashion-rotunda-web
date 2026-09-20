// Unit tests for camera presets.
// Verifies stable order (proof first), orbit limits compliance, and reduced-motion glideTo behavior.

import { Spherical, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogView } from '../../src/catalog/catalog';
import { createPresets, listPresets } from '../../src/camera/presets';
import type { OrbitHandle } from '../../src/camera/orbit';

const TEST_VIEWS: Record<string, CatalogView> = {
  entrance: { position: [0, 2.2, 6.2], target: [0, 1.0, 0], fov: 52 },
  proof: { position: [0, 1.7, 4.2], target: [0, 1.0, 0], fov: 40 },
  detail: { position: [0, 1.4, 1.396], target: [0, 1.3, 0], fov: 35 },
  inlay: { position: [0, 3.8, 1.8], target: [0, 0.1, 0], fov: 45 },
  dome: { position: [0, 1.1, 3.5], target: [0, 0.9, 0], fov: 55 },
};

const LIMITS = {
  minDistance: 1.2,
  maxDistance: 7,
  minPolar: 0.15,
  maxPolar: Math.PI / 2 - 0.05,
};

describe('camera presets', () => {
  it('orders proof first, then others by catalogue order', () => {
    const list = listPresets(TEST_VIEWS);
    expect(list.length).toBe(5);
    expect(list[0].id).toBe('proof');
    expect(list[0].label).toBe('Proof');
    expect(list.map((v) => v.id)).toEqual(['proof', 'entrance', 'detail', 'inlay', 'dome']);
  });

  it('verifies all preset views strictly respect orbit limits', () => {
    const list = listPresets(TEST_VIEWS);
    for (const view of list) {
      const pos = new Vector3(...view.position);
      const tgt = new Vector3(...view.target);
      const diff = new Vector3().subVectors(pos, tgt);
      const spherical = new Spherical().setFromVector3(diff);

      expect(
        spherical.radius,
        `view "${view.id}" distance ${spherical.radius.toFixed(3)} outside limits`,
      ).toBeGreaterThanOrEqual(LIMITS.minDistance);

      expect(
        spherical.radius,
        `view "${view.id}" distance ${spherical.radius.toFixed(3)} outside limits`,
      ).toBeLessThanOrEqual(LIMITS.maxDistance);

      expect(
        spherical.phi,
        `view "${view.id}" polar ${spherical.phi.toFixed(3)} below minPolar`,
      ).toBeGreaterThanOrEqual(LIMITS.minPolar);

      expect(
        spherical.phi,
        `view "${view.id}" polar ${spherical.phi.toFixed(3)} above maxPolar`,
      ).toBeLessThanOrEqual(LIMITS.maxPolar);
    }
  });

  it('goTo glides orbit to destination over ms', async () => {
    const glideTo = vi.fn<OrbitHandle['glideTo']>().mockResolvedValue();
    const fakeOrbit = { glideTo } as unknown as OrbitHandle;

    const presets = createPresets(TEST_VIEWS, fakeOrbit, () => false);
    await presets.goTo('detail', 800);

    expect(glideTo).toHaveBeenCalledWith([0, 1.4, 1.396], [0, 1.3, 0], 800, 35);
  });

  it('goTo uses 0 ms under reduced motion', async () => {
    const glideTo = vi.fn<OrbitHandle['glideTo']>().mockResolvedValue();
    const fakeOrbit = { glideTo } as unknown as OrbitHandle;

    const presets = createPresets(TEST_VIEWS, fakeOrbit, () => true);
    await presets.goTo('entrance', 1200);

    // Duration must be forced to 0.
    expect(glideTo).toHaveBeenCalledWith([0, 2.2, 6.2], [0, 1.0, 0], 0, 52);
  });

  it('passes the authored FOV for every named view', async () => {
    const glideTo = vi.fn<OrbitHandle['glideTo']>().mockResolvedValue();
    const presets = createPresets(TEST_VIEWS, { glideTo } as unknown as OrbitHandle, () => false);

    for (const [id, view] of Object.entries(TEST_VIEWS)) {
      await presets.goTo(id, 0);
      expect(glideTo).toHaveBeenLastCalledWith(view.position, view.target, 0, view.fov);
    }
  });
});
