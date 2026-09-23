import { DirectionalLight, RectAreaLight } from 'three';
import type { Light } from 'three';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RIG, updateDaylight, updateLight } from '../../src/lighting/rig';
import type { Rig } from '../../src/lighting/rig';
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
});
