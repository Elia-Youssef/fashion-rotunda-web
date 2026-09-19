import { DirectionalLight, PointLight, RectAreaLight, Vector3 } from 'three';
import type { Light } from 'three';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RIG, INDIRECT_DISTANCE_M, updateLight } from '../../src/lighting/rig';
import type { Rig } from '../../src/lighting/rig';
import { createThreeRig } from '../../src/lighting/three-rig';
import type { ThreeRig, ThreeRigOptions } from '../../src/lighting/three-rig';
import { candelaToNits, kelvinToRgb } from '../../src/lighting/units';

const OPTIONS: ThreeRigOptions = { shadowMapSize: 2048, sunShadow: true };

function build(rig: Rig = DEFAULT_RIG, options: ThreeRigOptions = OPTIONS): ThreeRig {
  return createThreeRig(rig, options);
}

function only(rig: ThreeRig, id: 'top' | 'key' | 'fill' | 'back' | 'sun'): Light {
  const lights = rig.lightsById.get(id);
  if (!lights || lights.length !== 1) throw new Error(`expected one light for ${id}`);
  return lights[0];
}

// Narrowing readers rather than casts: the class check runs in every test that reaches for a class
// specific field, so a rect light that quietly became something else fails here first.
function rect(rig: ThreeRig, id: 'top' | 'key' | 'fill' | 'back'): RectAreaLight {
  const light = only(rig, id);
  if (!(light instanceof RectAreaLight)) throw new Error(`${id} is not a RectAreaLight`);
  return light;
}

function sunOf(rig: ThreeRig): DirectionalLight {
  const light = only(rig, 'sun');
  if (!(light instanceof DirectionalLight)) throw new Error('sun is not a DirectionalLight');
  return light;
}

function ringOf(rig: ThreeRig): PointLight[] {
  const lights = rig.lightsById.get('indirect') ?? [];
  return lights.map((light) => {
    if (!(light instanceof PointLight)) throw new Error('ring member is not a PointLight');
    return light;
  });
}

/** Everything apply() is allowed to write, read back off the objects. */
function snapshot(rig: ThreeRig): string {
  const rows: unknown[] = [];
  for (const [id, lights] of rig.lightsById) {
    for (const light of lights) {
      rows.push({
        id,
        type: light.type,
        visible: light.visible,
        intensity: light.intensity,
        color: [light.color.r, light.color.g, light.color.b],
        position: light.position.toArray(),
        quaternion: light.quaternion.toArray(),
        castShadow: light.castShadow,
        width: light instanceof RectAreaLight ? light.width : null,
        height: light instanceof RectAreaLight ? light.height : null,
      });
    }
  }
  return JSON.stringify(rows);
}

describe('createThreeRig', () => {
  it('builds one object per rect light, eight for the ring, one sun and none for the sky', () => {
    const rig = build();
    expect(only(rig, 'top')).toBeInstanceOf(RectAreaLight);
    expect(only(rig, 'key')).toBeInstanceOf(RectAreaLight);
    expect(only(rig, 'fill')).toBeInstanceOf(RectAreaLight);
    expect(only(rig, 'back')).toBeInstanceOf(RectAreaLight);
    expect(only(rig, 'sun')).toBeInstanceOf(DirectionalLight);
    expect(rig.lightsById.get('indirect')).toHaveLength(8);
    expect(ringOf(rig)).toHaveLength(8);
    expect(rig.lightsById.get('sky')).toEqual([]);
  });

  it('adds every light plus the sun target to one group', () => {
    const rig = build();
    // 4 rect + 8 point + 1 sun + 1 target.
    expect(rig.group.children).toHaveLength(14);
    expect(rig.group.children.filter((child) => child.name === 'sun-target')).toHaveLength(1);
  });

  it('states the rect lights in nits, from candela and the panel area', () => {
    const rig = build();
    const top = only(rig, 'top');
    expect(top.intensity).toBe(candelaToNits(25, 4, 4));
    expect(top.intensity).toBe(1.5625);
    expect(only(rig, 'key').intensity).toBeCloseTo(candelaToNits(15, 0.6, 0.9), 12);
    expect(rect(rig, 'top').width).toBe(4);
    expect(rect(rig, 'top').height).toBe(4);
  });

  it('states the ring in candela and the sun in lux, straight through', () => {
    const rig = build();
    for (const light of ringOf(rig)) {
      expect(light.intensity).toBe(5);
      expect(light.distance).toBe(INDIRECT_DISTANCE_M);
      expect(light.decay).toBe(2);
    }
    expect(only(rig, 'sun').intensity).toBe(7);
  });

  it('colours each light from its own temperature', () => {
    const rig = build();
    const [r, g, b] = kelvinToRgb(4500);
    const key = only(rig, 'key');
    expect(key.color.r).toBeCloseTo(r, 9);
    expect(key.color.g).toBeCloseTo(g, 9);
    expect(key.color.b).toBeCloseTo(b, 9);
    // 6500 K is the white the tint is balanced against, so the top light is neutral.
    const top = only(rig, 'top');
    expect(top.color.r).toBeCloseTo(1, 6);
    expect(top.color.g).toBeCloseTo(1, 6);
    expect(top.color.b).toBeCloseTo(1, 6);
    // A warm light has more red than blue, whatever the numbers.
    expect(key.color.r).toBeGreaterThan(key.color.b);
  });

  it('puts each rect light where the rig says and aims it along its direction', () => {
    const rig = build();
    const key = only(rig, 'key');
    expect(key.position.toArray()).toEqual(DEFAULT_RIG.lights[1].position);
    // lookAt leaves the object's +z pointing back at itself from the target, so the light shines along -z.
    const forward = key.getWorldDirection(new Vector3()).multiplyScalar(-1);
    const expected = DEFAULT_RIG.lights[1].direction ?? [0, 0, 0];
    expect(forward.x).toBeCloseTo(expected[0], 6);
    expect(forward.y).toBeCloseTo(expected[1], 6);
    expect(forward.z).toBeCloseTo(expected[2], 6);
  });

  it('puts each ring light on its own member position', () => {
    const rig = build();
    const members = DEFAULT_RIG.lights[4].members ?? [];
    ringOf(rig).forEach((light, index) => {
      expect(light.position.toArray()).toEqual(members[index]);
    });
  });

  it('stands the sun off along its direction and points it at the origin', () => {
    const rig = build();
    const sun = only(rig, 'sun');
    const direction = DEFAULT_RIG.lights[5].direction ?? [0, 0, 0];
    expect(sun.position.length()).toBeCloseTo(20, 6);
    expect(sun.position.x).toBeCloseTo(-direction[0] * 20, 6);
    expect(sun.position.y).toBeCloseTo(-direction[1] * 20, 6);
    expect(sun.position.z).toBeCloseTo(-direction[2] * 20, 6);
    expect(sun.position.y).toBeGreaterThan(0);
    expect(sunOf(rig).target.position.toArray()).toEqual([0, 0, 0]);
  });

  it('gives the sun the only shadow map, sized and framed from the options', () => {
    const rig = build();
    const sun = sunOf(rig);
    expect(sun.castShadow).toBe(true);
    expect(sun.shadow.mapSize.width).toBe(2048);
    expect(sun.shadow.mapSize.height).toBe(2048);
    const camera = sun.shadow.camera;
    expect(camera.right - camera.left).toBe(18);
    expect(camera.top - camera.bottom).toBe(18);
    expect(camera.far).toBeGreaterThan(20);
    const rectIds: ('top' | 'key' | 'fill' | 'back')[] = ['top', 'key', 'fill', 'back'];
    for (const id of rectIds) {
      expect(only(rig, id).castShadow).toBe(false);
    }
    for (const light of ringOf(rig)) {
      expect(light.castShadow).toBe(false);
    }
  });

  it('leaves the sun shadowless when the tier says so', () => {
    const rig = build(DEFAULT_RIG, { shadowMapSize: 1024, sunShadow: false });
    expect(only(rig, 'sun').castShadow).toBe(false);
    expect(sunOf(rig).shadow.mapSize.width).toBe(1024);
  });
});

describe('ThreeRig.apply', () => {
  it('changes nothing when the same rig is applied twice', () => {
    const rig = build();
    const before = snapshot(rig);
    rig.apply(DEFAULT_RIG);
    expect(snapshot(rig)).toBe(before);
    rig.apply(DEFAULT_RIG);
    expect(snapshot(rig)).toBe(before);
  });

  it('switches a light off with visible, never by zeroing its intensity', () => {
    const rig = build();
    rig.apply(updateLight(DEFAULT_RIG, 'top', { on: false }));
    const top = only(rig, 'top');
    expect(top.visible).toBe(false);
    expect(top.intensity).toBe(1.5625);
  });

  it('starts the two lights the level starts off invisible, and can switch them on', () => {
    const rig = build();
    expect(only(rig, 'fill').visible).toBe(false);
    expect(only(rig, 'back').visible).toBe(false);
    rig.apply(updateLight(DEFAULT_RIG, 'fill', { on: true }));
    expect(only(rig, 'fill').visible).toBe(true);
  });

  it('switches the whole ring together', () => {
    const rig = build();
    rig.apply(updateLight(DEFAULT_RIG, 'indirect', { on: false, intensity: 9 }));
    for (const light of ringOf(rig)) {
      expect(light.visible).toBe(false);
      expect(light.intensity).toBe(9);
    }
  });

  it('follows the sun round its arc', () => {
    const rig = build();
    rig.apply(updateLight(DEFAULT_RIG, 'sun', { sunAngleDeg: 90 }));
    const sun = only(rig, 'sun');
    expect(sun.position.x).toBeCloseTo(0, 6);
    expect(sun.position.y).toBeCloseTo(20, 6);
    expect(sun.position.z).toBeCloseTo(0, 6);
  });

  it('adds and removes nothing: the objects outlive every change', () => {
    const rig = build();
    const objects = [...rig.group.children];
    rig.apply(updateLight(DEFAULT_RIG, 'key', { intensity: 3, kelvin: 8000, on: false }));
    expect(rig.group.children).toEqual(objects);
  });

  it('refuses a rect entry with no size rather than inventing one', () => {
    const rig = build();
    const broken: Rig = {
      exposure: 1,
      lights: [
        {
          id: 'top',
          label: 'TopLight',
          kind: 'rect',
          on: true,
          intensity: 25,
          kelvin: 6500,
          castShadow: false,
        },
      ],
    };
    expect(() => rig.apply(broken)).toThrow(TypeError);
  });
});

describe('ThreeRig.dispose', () => {
  it('empties the group', () => {
    const rig = build();
    expect(rig.group.children.length).toBeGreaterThan(0);
    rig.dispose();
    expect(rig.group.children).toHaveLength(0);
  });

  it('tells every light it is done, the sun included', () => {
    const rig = build();
    const seen: string[] = [];
    for (const lights of rig.lightsById.values()) {
      for (const light of lights) light.addEventListener('dispose', () => seen.push(light.type));
    }
    rig.dispose();
    // 4 rect, 8 point, 1 sun.
    expect(seen).toHaveLength(13);
  });
});
