// @vitest-environment jsdom
// Unit tests for camera presets.
// Verifies stable order (proof first), orbit limits compliance, and reduced-motion glideTo behavior.

import { Spherical, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogView } from '../../src/catalog/catalog';
import { createPresets, listPresets } from '../../src/camera/presets';
import type { NamedView } from '../../src/camera/presets';
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

describe('preset contracts', () => {
  it('rejects with the preset id when goTo is given an unknown id', async () => {
    const glideTo = vi.fn<OrbitHandle['glideTo']>().mockResolvedValue();
    const presets = createPresets(TEST_VIEWS, { glideTo } as unknown as OrbitHandle, () => false);

    await expect(presets.goTo('atrium')).rejects.toThrow('preset "atrium" not found');
    expect(glideTo).not.toHaveBeenCalled();
  });

  it('glides over the documented 1200 ms default when goTo is given no duration', async () => {
    const glideTo = vi.fn<OrbitHandle['glideTo']>().mockResolvedValue();
    const presets = createPresets(TEST_VIEWS, { glideTo } as unknown as OrbitHandle, () => false);

    await presets.goTo('detail');

    expect(glideTo).toHaveBeenCalledWith([0, 1.4, 1.396], [0, 1.3, 0], 1200, 35);
  });

  it('reads the system reduced-motion preference when no override is given', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    try {
      const glideTo = vi.fn<OrbitHandle['glideTo']>().mockResolvedValue();
      const presets = createPresets(TEST_VIEWS, { glideTo } as unknown as OrbitHandle);

      await presets.goTo('entrance', 1200);

      expect(glideTo).toHaveBeenCalledWith([0, 2.2, 6.2], [0, 1.0, 0], 0, 52);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not resolve before the orbit lands, and rejects when the glide fails', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const glideTo = vi.fn<OrbitHandle['glideTo']>().mockReturnValue(gate);
    const presets = createPresets(TEST_VIEWS, { glideTo } as unknown as OrbitHandle, () => false);

    let settled = false;
    const going = presets.goTo('detail', 100).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await going;
    expect(settled).toBe(true);

    glideTo.mockRejectedValueOnce(new Error('orbit unavailable'));
    await expect(presets.goTo('inlay')).rejects.toThrow('orbit unavailable');
  });

  it('publishes a list callers cannot grow', () => {
    const glideTo = vi.fn<OrbitHandle['glideTo']>().mockResolvedValue();
    const presets = createPresets(TEST_VIEWS, { glideTo } as unknown as OrbitHandle, () => false);

    expect(() => {
      (presets.list as NamedView[]).push({
        id: 'extra',
        label: 'Extra',
        position: [0, 0, 0],
        target: [0, 0, 0],
        fov: 40,
      });
    }).toThrow(TypeError);
  });

  it('labels an id the table does not know with the capitalized id', () => {
    const views: Record<string, CatalogView> = {
      atrium: { position: [0, 2, 5], target: [0, 1, 0], fov: 45 },
    };
    const list = listPresets(views);
    expect(list.map((v) => v.id)).toEqual(['atrium']);
    expect(list[0].label).toBe('Atrium');
  });

  it('labels a view named like an Object prototype key, not with the inherited answer', () => {
    // 'constructor' is a key Object.prototype already answers; the label lookup must fall
    // back to the capitalized id instead of returning that inherited value.
    const prototypeNamed: CatalogView = { position: [0, 3, 5], target: [0, 1, 0], fov: 45 };
    const views: Record<string, CatalogView> = { constructor: prototypeNamed };
    const list = listPresets(views);
    expect(list[0].label).toBe('Constructor');
  });

  it('lists every view in catalogue order when there is no proof view', () => {
    const views: Record<string, CatalogView> = {
      entrance: { position: [0, 2.2, 6.2], target: [0, 1.0, 0], fov: 52 },
      dome: { position: [0, 1.1, 3.5], target: [0, 0.9, 0], fov: 55 },
    };
    const list = listPresets(views);
    expect(list.map((v) => v.id)).toEqual(['entrance', 'dome']);
    expect(list.map((v) => v.fov)).toEqual([52, 55]);
  });

  it('owns its numbers: editing the catalogue after listing does not move the presets', () => {
    const views: Record<string, CatalogView> = {
      proof: { position: [0, 1.7, 4.2], target: [0, 1.0, 0], fov: 40 },
      atrium: { position: [1, 2, 3], target: [4, 5, 6], fov: 50 },
    };
    const list = listPresets(views);
    expect(list[0].position).not.toBe(views.proof.position);
    expect(list[1].position).not.toBe(views.atrium.position);

    views.proof.position[0] = 99;
    views.proof.target[2] = 99;
    views.atrium.position[1] = 99;
    views.atrium.target[0] = 99;
    views.atrium.fov = 99;

    expect(list[0].position).toEqual([0, 1.7, 4.2]);
    expect(list[0].target).toEqual([0, 1.0, 0]);
    expect(list[1].position).toEqual([1, 2, 3]);
    expect(list[1].target).toEqual([4, 5, 6]);
    expect(list[1].fov).toBe(50);
  });
});
