import { afterEach, beforeEach, expect, vi } from 'vitest';
import type { RenderTarget, Texture } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import {
  createHdrEnvironment,
  createProceduralEnvironment,
  createRoomEnvironment,
} from '../../src/lighting/environment';
import type { Environment } from '../../src/lighting/environment';

// The lighting-environment harness shared by the lighting-environment suites: module mocks for
// three's texture, render target, PMREM, loader and sky machinery, the fault-injection state
// those mocks read, the renderer double, the factory failure tables and the per-test reset
// hooks. The mocks and hooks register when this module loads, so every suite that imports the
// harness runs under them, and Vitest's per-file isolation gives each suite a fresh registry.
// A suite must import the harness before its first three.js import: only module imports
// resolved after the mocks register see them.

const state = vi.hoisted(() => ({
  fail: '',
  capturePixels: false,
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
      if (state.capturePixels) return new actual.DataTexture(...args);
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
    createGradientSkyTexture: vi.fn((palette: import('../../src/lighting/sky').SkyPalette, name: string) => {
      state.skyPalettes.push({ name, palette });
      const label = name.endsWith('lighting') ? 'source' : 'background';
      step(`${label}-create`);
      if (state.capturePixels) return record(label, sky.createGradientSkyTexture(palette, name));
      return record(label, new actual.DataTexture(new Uint16Array(512 * 256 * 4), 512, 256,
        undefined, actual.HalfFloatType));
    }),
  };
});

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
  state.capturePixels = false;
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

export { expectReleasedOnce, previousTarget, renderer, specs, state };
