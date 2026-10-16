import { DirectionalLight, RectAreaLight, Vector3 } from 'three';
import type { Light } from 'three';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RIG, updateDaylight, updateLight } from '../../src/lighting/rig';
import type { Rig, RigLight } from '../../src/lighting/rig';
import { createThreeRig } from '../../src/lighting/three-rig';
import type { RigLightLookupId, ThreeRig, ThreeRigOptions } from '../../src/lighting/three-rig';
import { candelaToNits } from '../../src/lighting/units';

const OPTIONS: ThreeRigOptions = { shadowMapSize: 2048, sunShadow: true };

function build(rig: Rig = DEFAULT_RIG, options: ThreeRigOptions = OPTIONS): ThreeRig {
  return createThreeRig(rig, options);
}

function only(rig: ThreeRig, id: RigLightLookupId): Light {
  const lights = rig.lightsById.get(id);
  if (!lights || lights.length !== 1) throw new Error(`expected one light for ${id}`);
  return lights[0];
}

function rect(rig: ThreeRig, id: 'key' | 'fill' | 'back'): RectAreaLight {
  const light = only(rig, id);
  if (!(light instanceof RectAreaLight)) throw new Error(`${id} is not a RectAreaLight`);
  return light;
}

function sunOf(rig: ThreeRig): DirectionalLight {
  const light = only(rig, 'sun');
  if (!(light instanceof DirectionalLight)) throw new Error('sun is not a DirectionalLight');
  return light;
}

/** The key light with one optional field removed, as a runtime rig with malformed data. */
function stripField(light: RigLight, field: 'position' | 'direction' | 'size'): RigLight {
  const copy: { [key: string]: unknown } = { ...light };
  delete copy[field];
  return copy as unknown as RigLight;
}

/** The default rig with the key light replaced. */
function rigWithKey(light: RigLight): Rig {
  return { ...DEFAULT_RIG, lights: [light, ...DEFAULT_RIG.lights.slice(1)] };
}

describe('createThreeRig', () => {
  it('builds exactly three RectAreaLights and one DirectionalLight', () => {
    const rig = build();
    expect(only(rig, 'key')).toBeInstanceOf(RectAreaLight);
    expect(only(rig, 'fill')).toBeInstanceOf(RectAreaLight);
    expect(only(rig, 'back')).toBeInstanceOf(RectAreaLight);
    expect(only(rig, 'sun')).toBeInstanceOf(DirectionalLight);
  });

  it('contains zero PointLights or Top lights in lightsById or group', () => {
    const rig = build();
    expect((rig.lightsById as Map<string, unknown>).has('top')).toBe(false);
    expect((rig.lightsById as Map<string, unknown>).has('indirect')).toBe(false);
    const pointLights = rig.group.children.filter((child) => child.type === 'PointLight');
    expect(pointLights).toHaveLength(0);
  });

  it('adds exactly 3 rect lights, 1 sun, and 1 sun target to the group (5 children)', () => {
    const rig = build();
    expect(rig.group.children).toHaveLength(5);
    expect(rig.group.children.filter((child) => child.name === 'sun-target')).toHaveLength(1);
    expect(rig.group.children.filter((child) => child.name === 'DaylightSun')).toHaveLength(1);
  });

  it('states the rect lights in nits from candela and area', () => {
    const rig = build();
    const key = rect(rig, 'key');
    expect(key.intensity).toBeCloseTo(candelaToNits(15, 0.6, 0.9), 6);
    expect(key.width).toBe(0.6);
    expect(key.height).toBe(0.9);
  });

  it('sets initial colors correctly on Three.js light objects', () => {
    const rig = build();
    const key = rect(rig, 'key');
    // Every default is neutral white 6500 K (client decision 2026-09-23); the Unreal-authored
    // Kelvin x tint colours (#bcc8bd, #b3dbff, #bce1ff) remain recorded in rig.ts.
    expect('#' + key.color.getHexString()).toBe('#ffffff');
    const fill = rect(rig, 'fill');
    expect('#' + fill.color.getHexString()).toBe('#ffffff');
    const back = rect(rig, 'back');
    expect('#' + back.color.getHexString()).toBe('#ffffff');
    expect('#' + sunOf(rig).color.getHexString()).toBe('#ffffff');
  });

  it('enforces one-shadow policy: only the Daylight sun casts shadows', () => {
    const rig = build();
    expect(sunOf(rig).castShadow).toBe(true);
    expect(rect(rig, 'key').castShadow).toBe(false);
    expect(rect(rig, 'fill').castShadow).toBe(false);
    expect(rect(rig, 'back').castShadow).toBe(false);
  });

  it('applies updated colors and intensities to the Three.js objects', () => {
    const rig = build();
    const next = updateLight(DEFAULT_RIG, 'key', {
      intensity: 25,
      color: '#ff0055',
    });
    rig.apply(next);

    const key = rect(rig, 'key');
    expect(key.intensity).toBeCloseTo(candelaToNits(25, 0.6, 0.9), 6);
    expect('#' + key.color.getHexString()).toBe('#ff0055');
  });

  it('repeated apply() preserves light object identity and never duplicates lights or targets', () => {
    const rig = build();
    const keyBefore = rect(rig, 'key');
    const fillBefore = rect(rig, 'fill');
    const backBefore = rect(rig, 'back');
    const sunBefore = sunOf(rig);
    const targetBefore = rig.group.children.find((child) => child.name === 'sun-target');

    // Toggles, slider moves, color changes and daylight changes, repeatedly and interleaved
    for (let i = 0; i < 3; i += 1) {
      rig.apply(updateLight(DEFAULT_RIG, 'key', { on: i % 2 === 0 }));
      rig.apply(updateLight(DEFAULT_RIG, 'key', { intensity: 20 + i, color: '#ff0055' }));
      rig.apply(updateLight(DEFAULT_RIG, 'fill', { on: true }));
      rig.apply(updateLight(DEFAULT_RIG, 'back', { on: true, color: '#00ff88' }));
      rig.apply(updateDaylight(DEFAULT_RIG, 0.1));
      rig.apply(DEFAULT_RIG);
    }

    expect(rect(rig, 'key')).toBe(keyBefore);
    expect(rect(rig, 'fill')).toBe(fillBefore);
    expect(rect(rig, 'back')).toBe(backBefore);
    expect(sunOf(rig)).toBe(sunBefore);
    const targets = rig.group.children.filter((child) => child.name === 'sun-target');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toBe(targetBefore);
    expect(rig.group.children).toHaveLength(5);
    expect(rig.group.children.filter((child) => child.type === 'RectAreaLight')).toHaveLength(3);

    // Restoring the defaults lands back on the neutral white default colors
    expect('#' + keyBefore.color.getHexString()).toBe('#ffffff');
    expect('#' + backBefore.color.getHexString()).toBe('#ffffff');
    expect(keyBefore.visible).toBe(true);
    expect(fillBefore.visible).toBe(false);
    expect(backBefore.visible).toBe(false);

    // Local lights never gain shadow casting through any update path
    expect(keyBefore.castShadow).toBe(false);
    expect(fillBefore.castShadow).toBe(false);
    expect(backBefore.castShadow).toBe(false);
    expect(sunBefore.castShadow).toBe(true);
  });

  it('applies daylight updates to the DirectionalLight', () => {
    const rig = build();
    const minRig = updateDaylight(DEFAULT_RIG, 0.0);
    rig.apply(minRig);

    const sun = sunOf(rig);
    expect(sun.intensity).toBeCloseTo(2.0, 1);
    expect('#' + sun.color.getHexString()).toBe('#ffd9a6');
    expect(sun.position.y).toBeCloseTo(15.212, 2);

    const refRig = updateDaylight(DEFAULT_RIG, 0.5);
    rig.apply(refRig);
    expect(sun.intensity).toBeCloseTo(7.0, 1);
    expect('#' + sun.color.getHexString()).toBe('#ffffff');

    const maxRig = updateDaylight(DEFAULT_RIG, 1.0);
    rig.apply(maxRig);
    expect(sun.intensity).toBeCloseTo(12.0, 1);
    expect('#' + sun.color.getHexString()).toBe('#eaf2ff');

    // Sun remains the only shadow caster throughout daylight changes
    expect(sun.castShadow).toBe(true);
    expect(rect(rig, 'key').castShadow).toBe(false);
    expect(rect(rig, 'fill').castShadow).toBe(false);
    expect(rect(rig, 'back').castShadow).toBe(false);
  });

  it('disposes all lights and clears group on dispose()', () => {
    const rig = build();
    expect(rig.group.children.length).toBeGreaterThan(0);
    rig.dispose();
    expect(rig.group.children).toHaveLength(0);
  });

  it('notifies every owned light about disposal', () => {
    const rig = build();
    const disposed: string[] = [];
    for (const [id, lights] of rig.lightsById) {
      for (const light of lights) light.addEventListener('dispose', () => disposed.push(id));
    }
    rig.dispose();
    expect([...disposed].sort()).toEqual(['back', 'fill', 'key', 'sun']);
  });

  it('rejects a rig light without a position', () => {
    const broken = rigWithKey(stripField(DEFAULT_RIG.lights[0], 'position'));
    expect(() => build(broken)).toThrow(TypeError);
    expect(() => build(broken)).toThrow(/rig light key needs a position/);
  });

  it('rejects a rig light without a direction', () => {
    const broken = rigWithKey(stripField(DEFAULT_RIG.lights[0], 'direction'));
    expect(() => build(broken)).toThrow(TypeError);
    expect(() => build(broken)).toThrow(/rig light key needs a direction/);
  });

  it('rejects a rig light without a size', () => {
    const broken = rigWithKey(stripField(DEFAULT_RIG.lights[0], 'size'));
    expect(() => build(broken)).toThrow(TypeError);
    expect(() => build(broken)).toThrow(/rig light key needs a size/);
  });

  it('places every rect light at its authored position', () => {
    const rig = build();
    for (const entry of DEFAULT_RIG.lights) {
      const position = entry.position;
      if (!position) throw new Error(`rig light ${entry.id} has no position`);
      expect(rect(rig, entry.id).position.toArray()).toEqual(position);
    }
  });

  it('aims every rect light along its authored direction', () => {
    const rig = build();
    const facing = new Vector3();
    for (const entry of DEFAULT_RIG.lights) {
      const direction = entry.direction;
      if (!direction) throw new Error(`rig light ${entry.id} has no direction`);
      // A light looks with its -Z axis: lookAt points that axis at the target.
      facing.set(0, 0, -1).applyQuaternion(rect(rig, entry.id).quaternion);
      expect(facing.x).toBeCloseTo(direction[0], 6);
      expect(facing.y).toBeCloseTo(direction[1], 6);
      expect(facing.z).toBeCloseTo(direction[2], 6);
    }
  });

  it('keeps the sun visible through every apply', () => {
    const rig = build();
    const sun = sunOf(rig);
    expect(sun.visible).toBe(true);
    rig.apply(updateDaylight(DEFAULT_RIG, 0));
    rig.apply(updateDaylight(DEFAULT_RIG, 1));
    rig.apply(DEFAULT_RIG);
    expect(sun.visible).toBe(true);
  });

  it('turns the sun shadow off when the option says so', () => {
    const rig = build(DEFAULT_RIG, { shadowMapSize: 1024, sunShadow: false });
    const sun = sunOf(rig);
    expect(sun.castShadow).toBe(false);
    rig.apply(updateDaylight(DEFAULT_RIG, 0.9));
    expect(sun.castShadow).toBe(false);
  });

  it('names the group and every light for scene inspection', () => {
    const rig = build();
    expect(rig.group.name).toBe('studio-rig');
    for (const entry of DEFAULT_RIG.lights) {
      expect(rect(rig, entry.id).name).toBe(entry.label);
    }
  });

  it('sizes the sun shadow map from the options', () => {
    const small = build(DEFAULT_RIG, { shadowMapSize: 512, sunShadow: true });
    expect(sunOf(small).shadow.mapSize.x).toBe(512);
    expect(sunOf(small).shadow.mapSize.y).toBe(512);
    const large = build(DEFAULT_RIG, { shadowMapSize: 4096, sunShadow: true });
    expect(sunOf(large).shadow.mapSize.x).toBe(4096);
    expect(sunOf(large).shadow.mapSize.y).toBe(4096);
  });

  it('fits the sun shadow frustum to the room', () => {
    const camera = sunOf(build()).shadow.camera;
    // The 16 m room needs the 9 m half extent at every sun angle; the far plane reaches
    // the sun at 20 m plus the frustum depth.
    expect(camera.left).toBe(-9);
    expect(camera.right).toBe(9);
    expect(camera.top).toBe(9);
    expect(camera.bottom).toBe(-9);
    expect(camera.near).toBe(1);
    expect(camera.far).toBe(38);
  });

  it('updates the shadow projection matrix to the configured frustum', () => {
    const elements = sunOf(build()).shadow.camera.projectionMatrix.elements;
    // Orthographic scale is 2 / (right - left) = 1/9 for the 9 m half extent; a stale
    // matrix would still carry 0.2 from three's default 5 m shadow camera.
    expect(elements[0]).toBeCloseTo(1 / 9, 6);
    expect(elements[5]).toBeCloseTo(1 / 9, 6);
  });

  it('links the sun target into the group so its world matrix updates', () => {
    const rig = build();
    const target = rig.group.children.find((child) => child.name === 'sun-target');
    expect(target).toBeDefined();
    expect(sunOf(rig).target).toBe(target);
  });

  it('skips rig entries it has no light for instead of throwing', () => {
    const rig = build();
    // Serialized v1 rigs once carried a 'top' light; apply must skip retired ids.
    const retired = { ...DEFAULT_RIG.lights[0], id: 'top', label: 'TopLight' } as unknown as RigLight;
    const extended: Rig = { ...DEFAULT_RIG, lights: [...DEFAULT_RIG.lights, retired] };
    expect(() => rig.apply(extended)).not.toThrow();
    rig.apply(updateLight(extended, 'key', { intensity: 30 }));
    expect(rect(rig, 'key').intensity).toBeCloseTo(candelaToNits(30, 0.6, 0.9), 6);
  });
});
