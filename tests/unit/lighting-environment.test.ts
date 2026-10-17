import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Texture } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

const state = vi.hoisted(() => ({
  fail: '',
  error: { reason: 'construction failed' },
  resources: [] as { name: string; resource: { dispose(): void } }[],
  releases: [] as string[],
  throwing: new Set<string>(),
  cleanupError: new Error('cleanup failed'),
  restoreFails: false,
  restoreError: new Error('restore failed'),
  converted: false,
  input: null as Texture | null,
  output: null as RenderTarget | null,
  roomBlur: 0,
  hdrUrl: '',
  hdrWidth: 64,
  hdrHeight: 32,
  skyPalettes: [] as { name: string; palette: unknown }[],
  boundTarget: null as unknown,
  boundFace: 2,
  boundLevel: 1,
  disruptRenderer: () => {},
}));

function step(name: string): void {
  if (state.fail === name) throw state.error;
}

function conversionStep(target: RenderTarget): void {
  if (state.fail === 'convert') {
    state.boundTarget = target;
    state.boundFace = 4;
    state.boundLevel = 3;
    state.disruptRenderer();
  }
  step('convert');
  state.converted = true;
}

function record<T extends { dispose(): void }>(name: string, resource: T): T {
  const original = resource.dispose.bind(resource);
  const disposable: { dispose(): void } = resource;
  vi.spyOn(disposable, 'dispose').mockImplementation(() => {
    state.releases.push(name);
    original();
    step(`release-${name}`);
    if (state.throwing.has(name)) throw state.cleanupError;
  });
  state.resources.push({ name, resource });
  return resource;
}

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return {
    ...actual,
    DataTexture: vi.fn(function (...args: ConstructorParameters<typeof actual.DataTexture>) {
      step('background-create');
      const texture = record('background', new actual.DataTexture(...args));
      Object.defineProperty(texture, 'mapping', {
        set(value: unknown) { step('background-config'); Object.defineProperty(this, 'mapping', { value }); },
        configurable: true,
      });
      return texture;
    }),
    RenderTarget: vi.fn(function (...args: ConstructorParameters<typeof actual.RenderTarget>) {
      step('target-create');
      const target = record('target', new actual.RenderTarget(...args));
      const texture = target.texture;
      Object.defineProperty(target, 'texture', {
        get() {
          if (target === state.output) {
            step('target-config');
            if (state.converted) step('handoff');
          }
          return texture;
        },
      });
      state.output = target;
      return target;
    }),
  };
});

vi.mock('three/webgpu', () => ({
  PMREMGenerator: vi.fn(function () {
    step('generator-create');
    return record('generator', {
      dispose() {},
      fromScene(room: unknown, sigma: number, near: unknown, far: unknown, options: { renderTarget: RenderTarget }) {
        expect(room).toBe(state.resources.find((entry) => entry.name === 'room')?.resource);
        expect(near).toBeUndefined();
        expect(far).toBeUndefined();
        state.roomBlur = sigma;
        expect(options.renderTarget).toBe(state.output);
        conversionStep(options.renderTarget);
        return options.renderTarget;
      },
      fromEquirectangular(source: Texture, target: RenderTarget) {
        state.input = source;
        expect(target).toBe(state.output);
        conversionStep(target);
        return target;
      },
    });
  }),
}));

vi.mock('three/addons/environments/RoomEnvironment.js', () => ({
  RoomEnvironment: vi.fn(function () {
    step('room-create');
    return record('room', { dispose() {} });
  }),
}));

vi.mock('three/addons/loaders/HDRLoader.js', async () => {
  const actual = await vi.importActual<typeof import('three')>('three');
  return {
    HDRLoader: vi.fn(function () {
      step('loader-create');
      return {
        load(url: string, onLoad: (source: Texture) => void, _progress: unknown, onError: (error: unknown) => void) {
          state.hdrUrl = url;
          step('load-start');
          const source = record('source', new actual.DataTexture(
            new Float32Array(state.hdrWidth * state.hdrHeight * 4), state.hdrWidth, state.hdrHeight,
            undefined, actual.FloatType));
          source.flipY = true;
          if (state.fail === 'orient') {
            Object.defineProperty(source, 'mapping', { set() { step('orient'); } });
          }
          if (state.fail === 'background-read') {
            Object.defineProperty(source, 'image', { get() { step('background-read'); } });
          }
          queueMicrotask(() => {
            if (state.fail === 'load-reject') onError(state.error);
            else onLoad(source);
          });
          return source;
        },
      };
    }),
  };
});

vi.mock('../../src/lighting/sky', async (importOriginal) => {
  const sky = await importOriginal<typeof import('../../src/lighting/sky')>();
  const actual = await vi.importActual<typeof import('three')>('three');
  return {
    ...sky,
    createGradientSkyTexture: vi.fn((palette: unknown, name: string) => {
      state.skyPalettes.push({ name, palette });
      const label = name.endsWith('lighting') ? 'source' : 'background';
      step(`${label}-create`);
      return record(label, new actual.DataTexture(new Uint16Array(512 * 256 * 4), 512, 256,
        undefined, actual.HalfFloatType));
    }),
  };
});

import {
  CubeUVReflectionMapping,
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  RepeatWrapping,
  RGBAFormat,
  RenderTarget,
  Scene,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import {
  createHdrEnvironment,
  createProceduralEnvironment,
  createRoomEnvironment,
  fromRenderTarget,
} from '../../src/lighting/environment';
import type { Environment } from '../../src/lighting/environment';
import { createGradientSkyTexture, environmentSkyPalette, visibleSkyPalette } from '../../src/lighting/sky';
import { createSkyOnlyBackground } from '../../src/lighting/visible-sky';

interface FactorySpec {
  name: string;
  build(renderer: WebGPURenderer): Promise<Environment>;
  retained: readonly string[];
  temporary: readonly string[];
  width: number;
  height: number;
  failures: readonly (readonly [phase: string, names: readonly string[]])[];
}

const specs: readonly FactorySpec[] = [
  {
    name: 'room',
    build: createRoomEnvironment,
    retained: ['target'],
    temporary: ['room', 'generator'],
    width: 768,
    height: 1024,
    failures: [
      ['init', []], ['generator-create', []], ['room-create', ['generator']],
      ['target-create', ['generator', 'room']], ['target-config', ['generator', 'room', 'target']],
      ['convert', ['generator', 'room', 'target']], ['release-room', ['generator', 'room', 'target']],
      ['release-generator', ['generator', 'room', 'target']], ['handoff', ['generator', 'room', 'target']],
    ],
  },
  {
    name: 'procedural',
    build: createProceduralEnvironment,
    retained: ['background', 'target'],
    temporary: ['generator', 'source'],
    width: 384,
    height: 512,
    failures: [
      ['init', []], ['source-create', []], ['background-create', ['source']],
      ['generator-create', ['source', 'background']], ['target-create', ['source', 'background', 'generator']],
      ['target-config', ['source', 'background', 'generator', 'target']],
      ['convert', ['source', 'background', 'generator', 'target']],
      ['release-generator', ['source', 'background', 'generator', 'target']],
      ['release-source', ['source', 'background', 'generator', 'target']],
      ['handoff', ['source', 'background', 'generator', 'target']],
    ],
  },
  {
    name: 'hdr',
    build: (renderer: WebGPURenderer) => createHdrEnvironment(renderer, '/sky.hdr'),
    retained: ['source', 'background', 'target'],
    temporary: ['generator'],
    width: 336,
    height: 64,
    failures: [
      ['init', []], ['loader-create', []], ['load-start', []], ['load-reject', ['source']],
      ['orient', ['source']], ['background-read', ['source']], ['background-create', ['source']],
      ['background-config', ['source', 'background']], ['generator-create', ['source', 'background']],
      ['target-create', ['source', 'background', 'generator']],
      ['target-config', ['source', 'background', 'generator', 'target']],
      ['convert', ['source', 'background', 'generator', 'target']],
      ['release-generator', ['source', 'background', 'generator', 'target']],
      ['handoff', ['source', 'background', 'generator', 'target']],
    ],
  },
];

const previousTarget = { name: 'previous target' };
const renderer = {
  autoClear: true,
  init: vi.fn(async () => { step('init'); }),
  getRenderTarget: vi.fn(() => state.boundTarget),
  getActiveCubeFace: vi.fn(() => state.boundFace),
  getActiveMipmapLevel: vi.fn(() => state.boundLevel),
  setRenderTarget: vi.fn((target: unknown, face: number, level: number) => {
    if (state.restoreFails) throw state.restoreError;
    state.boundTarget = target;
    state.boundFace = face;
    state.boundLevel = level;
  }),
};

beforeEach(() => {
  state.fail = '';
  state.resources = [];
  state.releases = [];
  state.throwing.clear();
  state.restoreFails = false;
  state.converted = false;
  state.input = null;
  state.output = null;
  state.roomBlur = 0;
  state.hdrUrl = '';
  state.hdrWidth = 64;
  state.hdrHeight = 32;
  state.skyPalettes = [];
  state.boundTarget = previousTarget;
  state.boundFace = 2;
  state.boundLevel = 1;
  renderer.autoClear = true;
  state.disruptRenderer = () => { renderer.autoClear = false; };
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => { vi.restoreAllMocks(); });

function expectReleasedOnce(): void {
  for (const { resource } of state.resources) expect(resource.dispose).toHaveBeenCalledTimes(1);
}

for (const spec of specs) {
  describe(`${spec.name} environment ownership`, () => {
    it('detaches only its own maps from every scene before releasing textures', async () => {
      const environment = await spec.build(renderer as unknown as WebGPURenderer);
      const scenes = Array.from({ length: 4 }, () => new Scene());
      const foreign = environment.texture.clone();
      for (const scene of scenes) environment.apply(scene, 0.4);
      environment.apply(scenes[0], 0.6);
      const background = scenes[0].background;
      scenes[1].environment = foreign;
      scenes[2].background = foreign;
      scenes[3].environment = foreign;
      scenes[3].background = foreign;
      const unapplied = new Scene();
      unapplied.environment = environment.texture;
      unapplied.background = background;

      const expectDetached = (): void => {
        expect(scenes.map((scene) => scene.environment)).toEqual([null, foreign, null, foreign]);
        expect(scenes.map((scene) => scene.background)).toEqual([null, null, foreign, foreign]);
        expect(unapplied.environment).toBe(environment.texture);
        expect(unapplied.background).toBe(background);
      };
      state.output!.addEventListener('dispose', expectDetached);
      environment.dispose();
      expectDetached();
      expectReleasedOnce();
      foreign.dispose();
    });

    it.each(spec.failures)('releases exactly the acquired resources after %s and preserves the error', async (phase, names) => {
      state.fail = phase;
      await expect(spec.build(renderer as unknown as WebGPURenderer)).rejects.toBe(state.error);
      expect(state.resources.map((entry) => entry.name)).toEqual(names);
      expectReleasedOnce();
    });

    it('retains the same successful output and releases only the original temporary work', async () => {
      const environment = await spec.build(renderer as unknown as WebGPURenderer);
      expect(state.releases).toEqual(spec.temporary);
      const target = state.output!;
      expect(environment.texture).toBe(target.texture);
      expect(target.width).toBe(spec.width);
      expect(target.height).toBe(spec.height);
      expect(target.depthBuffer).toBe(spec.name === 'room');
      expect(target.texture.type).toBe(HalfFloatType);
      expect(target.texture.format).toBe(RGBAFormat);
      expect(target.texture.colorSpace).toBe(LinearSRGBColorSpace);
      expect(target.texture.mapping).toBe(CubeUVReflectionMapping);
      expect(target.texture.magFilter).toBe(LinearFilter);
      expect(target.texture.minFilter).toBe(LinearFilter);
      expect(target.texture.generateMipmaps).toBe(false);
      expect(target.texture).toHaveProperty('isPMREMTexture', true);
      expect(target.texture.name).toBe('PMREM.cubeUv');
      expect(target.scissorTest).toBe(true);
      const scene = new Scene();
      environment.apply(scene, 0.4, 0.25);
      expect(scene.environment).toBe(target.texture);
      expect(scene.environmentIntensity).toBe(0.4);
      const background = state.resources.find((entry) => entry.name === 'background')?.resource;
      expect(scene.background).toBe(background ?? null);
      if (spec.name === 'room') expect(state.roomBlur).toBe(0.3);
      if (spec.name === 'hdr') {
        expect(state.hdrUrl).toBe('/sky.hdr');
        expect(state.input!.flipY).toBe(true);
        // orientHdrEquirectangular ran before the visible copy was derived, so the copy the
        // visitor sees through the dome carries the equirectangular mapping of its source.
        const visible = background as DataTexture | undefined;
        expect(visible?.mapping).toBe(EquirectangularReflectionMapping);
      }
      for (const { name, resource } of state.resources) {
        expect(resource.dispose).toHaveBeenCalledTimes(spec.retained.some((retained) => retained === name) ? 0 : 1);
      }
      environment.dispose();
      expectReleasedOnce();
      expect(console.warn).not.toHaveBeenCalled();
      expect(renderer.setRenderTarget).not.toHaveBeenCalled();
    });

    it.each(spec.name === 'room' ? ['generator', 'room', 'target'] : ['source', 'background', 'generator', 'target'])(
      'attempts every release when %s disposal throws during rollback', async (name) => {
        state.fail = 'convert';
        state.throwing.add(name);
        await expect(spec.build(renderer as unknown as WebGPURenderer)).rejects.toBe(state.error);
        expectReleasedOnce();
        expect(console.warn).toHaveBeenCalledExactlyOnceWith(
          '[archviz] environment resource release failed', [state.cleanupError],
        );
        expect(renderer.setRenderTarget).toHaveBeenCalledExactlyOnceWith(previousTarget, 2, 1);
        expect(state.boundTarget).toBe(previousTarget);
        expect(state.boundFace).toBe(2);
        expect(state.boundLevel).toBe(1);
        expect(renderer.autoClear).toBe(true);
      },
    );

    it('reports multiple failed releases once and preserves a failed render target restore', async () => {
      state.fail = 'convert';
      state.restoreFails = true;
      for (const name of ['source', 'background', 'generator', 'room', 'target']) state.throwing.add(name);
      await expect(spec.build(renderer as unknown as WebGPURenderer)).rejects.toBe(state.error);
      expectReleasedOnce();
      expect(console.warn).toHaveBeenCalledTimes(2);
      expect(console.warn).toHaveBeenNthCalledWith(1,
        '[archviz] environment render target restore failed', state.restoreError);
      expect(console.warn).toHaveBeenNthCalledWith(2,
        '[archviz] environment resource release failed', state.resources.map(() => state.cleanupError));
    });
  });
}

describe('environment construction contracts', () => {
  it('rounds a non-power-of-two panorama quarter down to the PMREM cube size', async () => {
    state.hdrWidth = 600;
    state.hdrHeight = 300;
    const environment = await createHdrEnvironment(renderer as unknown as WebGPURenderer, '/sky.hdr');
    expect(state.output!.width).toBe(384);
    expect(state.output!.height).toBe(512);
    environment.dispose();
  });

  it('prefilters the procedural lighting copy, not the visible background', async () => {
    const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer);
    const source = state.resources.find((entry) => entry.name === 'source')?.resource;
    expect(state.input).toBe(source);
    environment.dispose();
  });

  it('prefilters the loaded HDR panorama, not the derived visible background', async () => {
    const environment = await createHdrEnvironment(renderer as unknown as WebGPURenderer, '/sky.hdr');
    const source = state.resources.find((entry) => entry.name === 'source')?.resource;
    expect(state.input).toBe(source);
    environment.dispose();
  });

  it('builds the lighting copy from the environment palette and the visible copy from the visible palette', async () => {
    const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer);
    environment.dispose();
    const byName = new Map(state.skyPalettes.map((call) => [call.name, call.palette] as const));
    expect(byName.get('procedural sky lighting')).toEqual(environmentSkyPalette());
    expect(byName.get('procedural sky visible')).toEqual(visibleSkyPalette());
  });

  it('applies the documented default background intensity and blur', async () => {
    const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer);
    const scene = new Scene();
    environment.apply(scene, 0.4);
    expect(scene.environmentIntensity).toBe(0.4);
    expect(scene.backgroundIntensity).toBe(0.25);
    expect(scene.backgroundBlurriness).toBe(0.08);
    environment.dispose();

    const room = await createRoomEnvironment(renderer as unknown as WebGPURenderer);
    const bare = new Scene();
    room.apply(bare, 0.5);
    expect(bare.background).toBeNull();
    expect(bare.backgroundIntensity).toBe(1);
    expect(bare.backgroundBlurriness).toBe(0);
    room.dispose();
  });

  it('releases a texture used as both background and source exactly once', () => {
    const target = new RenderTarget(16, 16);
    const shared = new DataTexture(new Float32Array(2 * 2 * 4), 2, 2, undefined, FloatType);
    fromRenderTarget(target, shared, shared).dispose();
    expect(shared.dispose).toHaveBeenCalledTimes(1);
    expect(target.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('visible HDR background derivation', () => {
  it('rejects sources that are not half or full floating-point HDR data textures', () => {
    const misTyped = new DataTexture(new Float32Array(2 * 4 * 4), 2, 4, undefined, FloatType);
    misTyped.type = UnsignedByteType;
    expect(() => createSkyOnlyBackground(misTyped)).toThrow(TypeError);
    expect(() => createSkyOnlyBackground(misTyped))
      .toThrowError('HDR background source must use half or full floating-point pixels');

    const singleColumn = new DataTexture(new Float32Array(1 * 4 * 4), 1, 4, undefined, FloatType);
    expect(() => createSkyOnlyBackground(singleColumn))
      .toThrowError('HDR background source must be a floating-point data texture');

    const bytePixels = new DataTexture(new Uint8Array(2 * 4 * 4), 2, 4, undefined, UnsignedByteType);
    expect(() => createSkyOnlyBackground(bytePixels))
      .toThrowError('HDR background source must be a floating-point data texture');
  });

  it('caps the derived background at 512 by half that in pixels, and at two rows', () => {
    const wide = new DataTexture(new Float32Array(600 * 600 * 4), 600, 600, undefined, FloatType);
    wide.name = 'school field';
    wide.mapping = EquirectangularReflectionMapping;
    wide.colorSpace = SRGBColorSpace;
    wide.wrapS = RepeatWrapping;
    wide.wrapT = RepeatWrapping;
    wide.magFilter = LinearFilter;
    wide.minFilter = LinearMipmapLinearFilter;
    wide.anisotropy = 8;
    wide.generateMipmaps = false;
    wide.flipY = true;
    const background = createSkyOnlyBackground(wide) as DataTexture;
    expect(background.image.width).toBe(512);
    expect(background.image.height).toBe(256);
    expect(background.name).toBe('school field visible sky');
    expect(background.type).toBe(FloatType);
    expect(background.mapping).toBe(EquirectangularReflectionMapping);
    expect(background.colorSpace).toBe(SRGBColorSpace);
    expect(background.wrapS).toBe(RepeatWrapping);
    expect(background.wrapT).toBe(RepeatWrapping);
    expect(background.magFilter).toBe(LinearFilter);
    expect(background.minFilter).toBe(LinearMipmapLinearFilter);
    expect(background.anisotropy).toBe(8);
    expect(background.generateMipmaps).toBe(false);
    expect(background.flipY).toBe(true);
    // three's needsUpdate is a write-only setter that bumps version, so the readable proof
    // that createSkyOnlyBackground flagged the copy for upload is a positive version.
    expect(background.version).toBeGreaterThan(0);

    const tiny = new DataTexture(new Float32Array(2 * 4 * 4), 2, 4, undefined, FloatType);
    const small = createSkyOnlyBackground(tiny) as DataTexture;
    expect(small.image.width).toBe(2);
    expect(small.image.height).toBe(2);
    expect(small.name).toBe('HDR visible sky');
  });

  it('round-trips half-float sky pixels through the derived background', () => {
    const encode = DataUtils.toHalfFloat;
    const decode = DataUtils.fromHalfFloat;
    const width = 2;
    const height = 2;
    const top = [1.5, 0.5, 2, 1];
    const bottom = [0.25, 3, 0.125, 1];
    const pixels = new Uint16Array(width * height * 4);
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        pixels[4 * (0 * width + x) + channel] = encode(top[channel]);
        pixels[4 * (1 * width + x) + channel] = encode(bottom[channel]);
      }
    }
    const source = new DataTexture(pixels, width, height, undefined, HalfFloatType);
    source.flipY = true;
    const background = createSkyOnlyBackground(source) as DataTexture;
    expect(background.type).toBe(HalfFloatType);
    const visible = background.image.data as Uint16Array;
    for (let channel = 0; channel < 4; channel += 1) {
      // Row 0 keeps the preserved zenith row exactly; row 1 samples the source between rows 0
      // and 1 at the remapped position (preserve 0.2 to limit 0.245 of the source height).
      expect(decode(visible[4 * (0 * width) + channel])).toBe(top[channel]);
      expect(decode(visible[4 * (1 * width) + channel]))
        .toBeCloseTo(top[channel] + (bottom[channel] - top[channel]) * 0.245, 2);
    }
  });
});

describe('procedural daylight updates', () => {
  it('releases every replaced texture and target once across many slider changes', async () => {
    const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer);
    const scene = new Scene();
    let previous = environment.texture;
    for (let step = 0; step < 101; step += 1) {
      const daylight = step / 100;
      environment.updateDaylight!(daylight);
      expect(environment.texture).not.toBe(previous);
      environment.apply(scene, 0.4, 0.25);
      expect(scene.environment).toBe(environment.texture);
      expect(scene.background).toBe(state.resources.at(-3)!.resource);
      expect(createGradientSkyTexture).toHaveBeenLastCalledWith(visibleSkyPalette(daylight), 'procedural sky visible');
      expect(createGradientSkyTexture).toHaveBeenNthCalledWith(
        2 * (step + 1) + 1, environmentSkyPalette(daylight), 'procedural sky lighting');
      const live = state.resources.filter(({ resource }) => vi.mocked(resource.dispose).mock.calls.length === 0);
      expect(live.map(({ name }) => name)).toEqual(['background', 'target']);
      for (const { resource } of state.resources) {
        expect(vi.mocked(resource.dispose).mock.calls.length).toBeLessThanOrEqual(1);
      }
      previous = environment.texture;
    }
    environment.dispose();
    environment.dispose();
    const acquisitions = state.resources.length;
    environment.updateDaylight!(0.25);
    expect(state.resources).toHaveLength(acquisitions);
    expectReleasedOnce();
  });

  it('reuses texture objects and performs no construction for unchanged daylight', async () => {
    const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer);
    const texture = environment.texture;
    const acquired = state.resources.length;
    for (let frame = 0; frame < 100; frame += 1) {
      environment.updateDaylight!(0.5);
      environment.apply(new Scene(), 0.4, 0.25);
    }
    environment.updateDaylight!(Number.NaN);
    expect(state.resources).toHaveLength(acquired);
    expect(environment.texture).toBe(texture);
    environment.dispose();
    expectReleasedOnce();
  });

  it.each(specs[1].failures.filter(([phase]) => phase !== 'init'))(
    'keeps the previous environment live after a failed %s update and permits retry', async (phase) => {
      const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer);
      const scene = new Scene();
      environment.apply(scene, 0.4, 0.25);
      const texture = scene.environment;
      const background = scene.background;
      const previous = state.resources.slice();
      const acquired = previous.length;
      state.converted = false;
      state.fail = phase;
      expect(() => environment.updateDaylight!(0)).toThrow(state.error);
      expect(environment.texture).toBe(texture);
      environment.apply(scene, 0.4, 0.25);
      expect(scene.environment).toBe(texture);
      expect(scene.background).toBe(background);
      for (const { name, resource } of previous) {
        expect(resource.dispose).toHaveBeenCalledTimes(name === 'background' || name === 'target' ? 0 : 1);
      }
      for (const { resource } of state.resources.slice(acquired)) expect(resource.dispose).toHaveBeenCalledTimes(1);
      state.fail = '';
      environment.updateDaylight!(0);
      expect(environment.texture).not.toBe(texture);
      environment.dispose();
      expectReleasedOnce();
    },
  );
});
