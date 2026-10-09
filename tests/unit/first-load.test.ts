import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from 'three/webgpu';
import type { GLTF, GLTFLoader, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentUrl, loadCatalog } from '../../src/catalog/catalog';
import type { Catalog } from '../../src/catalog/catalog';
import { composeLighting, enableShadows, ROOM_ENVIRONMENT_SCALE } from '../../src/lighting/compose';
import type { Environment } from '../../src/lighting/environment';
import { DEFAULT_RIG, daylightParameters, serializeRig } from '../../src/lighting/rig';
import { createShowroom } from '../../src/scene/showroom';
import type { Showroom } from '../../src/scene/showroom';

const mocks = vi.hoisted(() => ({
  loader: vi.fn(), procedural: vi.fn(), hdr: vi.fn(), fallback: vi.fn(), panel: vi.fn(),
}));
vi.mock('../../src/scene/loaders', () => ({ createGltfLoader: mocks.loader }));
vi.mock('../../src/lighting/environment', () => ({
  createProceduralEnvironment: mocks.procedural,
  createHdrEnvironment: mocks.hdr,
  createRoomEnvironment: mocks.fallback,
}));
vi.mock('../../src/lighting/rect-area-ltc', () => ({ registerRectAreaLights: vi.fn() }));
vi.mock('../../src/ui/lightpanel', () => ({ mountLightPanel: mocks.panel }));

// Execute the actual first-load composition and publishers, without page boot or a renderer.
const source = ts.createSourceFile('main.ts', readFileSync('src/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function findNode<T extends ts.Node>(match: (node: ts.Node) => node is T): T {
  let found: T | undefined;
  function visit(node: ts.Node): void {
    if (match(node)) found = node;
    else ts.forEachChild(node, visit);
  }
  visit(source);
  if (found === undefined) throw new Error('missing first-load source');
  return found;
}
function functionText(name: string): string {
  return findNode((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source);
}
const startup = findNode((node): node is ts.TryStatement => ts.isTryStatement(node) &&
  node.tryBlock.statements[0]?.getText(source).includes('await loadContentSet') === true);
const statements = startup.tryBlock.statements;
const publishIndex = statements.findIndex((node) => node.getText(source) === 'publishSceneState();');
if (publishIndex < 0 || startup.catchClause === undefined) throw new Error('missing readiness publication');
const snippet = statements.slice(0, publishIndex + 2).map((node) => node.getText(source)).join('\n');
const compiled = ts.transpileModule(`
  let showroom = null, contentOnScreen = false, frameCount = 0, frameWaiters = [];
  const chain = null, proofOn = false;
  ${['loadContentSet', 'chooseLook', 'chooseVariant', 'publishSceneState', 'drawFrame'].map(functionText).join('\n')}
  return {
    async run() { try { ${snippet} } ${startup.catchClause.getText(source)} },
    drawFrame,
    get showroom() { return showroom; },
    get contentOnScreen() { return contentOnScreen; }
  };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const marks = ts.createSourceFile('marks.ts', readFileSync('src/proof/marks.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const markFunction = marks.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'markFirstFrame');
if (markFunction === undefined) throw new Error('missing first-frame mark');
const markCode = ts.transpileModule(markFunction.getText(marks).replace('export ', ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const catalog: Catalog = {
  version: 1, environment: { file: 'sky.hdr' }, rotunda: { file: 'rotunda.glb' },
  plinth: { file: 'plinth.glb' },
  looks: ['first', 'second'].map((id) => ({
    id, name: id, description: id, thumbnail: null, file: `looks/${id}.glb`,
    variants: ['base', 'light', 'dark'], defaultVariant: 'base', mannequinNode: 'mannequin',
  })),
  views: { proof: { position: [0, 2, 5], target: [0, 1, 0], fov: 45 } },
};

function fixture(name: string, hasDark = true) {
  const root = new Group();
  root.name = name;
  const material = new MeshStandardMaterial();
  const mesh = new Mesh(new BoxGeometry(2, 2, 2), material);
  const variants = hasDark ? ['base', 'light', 'dark'] : ['base', 'light'];
  mesh.userData['gltfExtensions'] = { KHR_materials_variants: {
    mappings: variants.map((_name, index) => ({ material: index, variants: [index] })),
  } };
  root.add(mesh);
  const parser: GLTFParser = Object.create(null);
  parser.getDependency = vi.fn(async (_type: string, index: number) =>
    new MeshStandardMaterial({ name: variants[index] }));
  parser.assignFinalMaterial = vi.fn();
  const gltf: GLTF = Object.create(null);
  Object.assign(gltf, { scene: root, parser, userData: {
    gltfExtensions: { KHR_materials_variants: { variants: variants.map((name) => ({ name })) } },
  } });
  return { root, mesh, gltf, parser, disposal: vi.spyOn(mesh.geometry, 'dispose') };
}

function harness(search = '?look=second&variant=dark', half = false, hasDark = true) {
  const sky = deferred<Environment>();
  const fallback = deferred<Environment>();
  mocks.procedural.mockReturnValue(sky.promise);
  mocks.hdr.mockReturnValue(sky.promise);
  mocks.fallback.mockReturnValue(fallback.promise);
  mocks.panel.mockReturnValue({ dispose: vi.fn(), setRig: vi.fn() });
  const environment: Environment = {
    texture: new Texture(),
    apply: vi.fn((scene, intensity, backgroundIntensity) => {
      scene.environment = environment.texture;
      scene.environmentIntensity = intensity;
      scene.backgroundIntensity = backgroundIntensity ?? 0.25;
    }),
    dispose: vi.fn(),
  };
  const assets = { rotunda: fixture('rotunda'), plinth: fixture('plinth'), look: fixture('look', hasDark) };
  const pending = { rotunda: deferred<GLTF>(), plinth: deferred<GLTF>(), look: deferred<GLTF>() };
  const base = half ? '/content/half' : '/content';
  const urls = new Map([
    [base + '/rotunda.glb', pending.rotunda], [base + '/plinth.glb', pending.plinth],
    [base + '/looks/first.glb', pending.look], [base + '/looks/second.glb', pending.look],
  ]);
  const parse = vi.fn((bytes: ArrayBuffer) => {
    const result = urls.get(new TextDecoder().decode(bytes));
    if (result === undefined) throw new Error('unexpected GLB');
    return result.promise;
  });
  const loader: GLTFLoader = Object.create(null);
  loader.parseAsync = parse;
  mocks.loader.mockResolvedValue(loader);
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return new Response(url.endsWith('catalog.json') ? JSON.stringify(catalog) : url);
  });
  vi.stubGlobal('fetch', fetchFn);
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  const render = vi.fn();
  const renderer = {
    shadowMap: { enabled: false }, render, toneMappingExposure: 1,
    info: { reset: vi.fn(), memory: { geometries: 0, textures: 0 } },
  };
  const canvas = { dataset: { scene: 'loading' } as DOMStringMap };
  const lobby = { setError: vi.fn() };
  const params = new URLSearchParams(search);
  const dependencies = {
    loadCatalog, contentUrl, createShowroom, composeLighting, enableShadows, params,
    FULL_CONTENT_BASE: '/content', HALF_CONTENT_BASE: '/content/half',
    settings: { assetSet: half ? 'half-on-touch' : 'full', shadowMapSize: 1024 }, isTouch: half,
    renderer, canvas, lobby, shell: { roots: { lightPanel: {} } },
    loop: { invalidate: vi.fn() }, resize: vi.fn(),
    markFirstFrame: new Function(`let firstFrameMarked = false; const FIRST_FRAME_MARK = 'first-frame';
      ${markCode} return markFirstFrame;`)(),
  };
  const boot = new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies)) as {
    run(): Promise<void>; drawFrame(): void; readonly showroom: Showroom | null; readonly contentOnScreen: boolean;
  };
  const run = boot.run();
  async function started(): Promise<void> {
    await vi.waitFor(() => {
      expect(parse).toHaveBeenCalledTimes(3);
      expect(mocks.procedural.mock.calls.length + mocks.hdr.mock.calls.length).toBe(1);
    });
  }
  function resolve(kind: 'lighting' | 'statics' | 'look'): void {
    if (kind === 'lighting') sky.resolve(environment);
    else if (kind === 'look') pending.look.resolve(assets.look.gltf);
    else {
      pending.rotunda.resolve(assets.rotunda.gltf);
      pending.plinth.resolve(assets.plinth.gltf);
    }
  }
  return { boot, run, started, resolve, sky, fallback, environment, assets, pending, canvas, lobby, render,
    parse, fetchFn, renderer, base };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  performance.clearMarks('first-frame');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('first-load composition', () => {
  const orders: ('lighting' | 'statics' | 'look')[][] = [
    ['lighting', 'statics', 'look'], ['lighting', 'look', 'statics'],
    ['statics', 'lighting', 'look'], ['statics', 'look', 'lighting'],
    ['look', 'lighting', 'statics'], ['look', 'statics', 'lighting'],
  ];
  it.each(orders.map((order) => [order.join(', '), order] as const))(
    'starts all preparation before resolving anything and publishes only ready content: %s',
    async (_name, order) => {
      const linkedRig = { ...DEFAULT_RIG, daylight: 0.8, exposure: 1.3 };
      const h = harness('?sky=hdr&look=second&variant=dark&rig=' + encodeURIComponent(serializeRig(linkedRig)), true);
      await h.started();
      expect(h.assets.look.root.parent).toBeNull();
      expect(h.assets.rotunda.root.parent).toBeNull();
      expect(mocks.panel).not.toHaveBeenCalled();
      for (const kind of order) {
        h.resolve(kind);
        // Drain the promise reactions before inspecting the scene between resolution steps.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (kind !== order[2]) {
          expect(h.boot.contentOnScreen).toBe(false);
          h.boot.drawFrame();
          expect(h.canvas.dataset.scene).toBe('loading');
          expect(performance.getEntriesByName('first-frame')).toHaveLength(0);
        }
        if (!order.slice(0, order.indexOf(kind) + 1).includes('lighting')) {
          expect(h.assets.rotunda.root.parent).toBeNull();
          expect(h.assets.look.root.parent).toBeNull();
          expect(mocks.panel).not.toHaveBeenCalled();
        }
        if (order.slice(0, order.indexOf(kind) + 1).includes('look')) {
          expect(h.assets.look.parser.getDependency).toHaveBeenCalled();
        }
      }
      await h.run;
      const room = h.boot.showroom!;
      expect(room.currentLook).toBe('second');
      expect(room.currentVariant).toBe('dark');
      expect(h.assets.look.mesh.material.name).toBe('dark');
      expect(h.assets.look.root.position.y).toBe(1);
      expect(h.assets.rotunda.root.parent).toBe(room.scene);
      expect(h.assets.look.root.parent).toBe(h.assets.plinth.root.parent);
      expect(h.assets.look.mesh.castShadow).toBe(true);
      expect(room.scene.environment).toBe(h.environment.texture);
      expect(h.renderer.toneMappingExposure).toBe(linkedRig.exposure);
      expect(mocks.panel.mock.calls[0][1].rig).toEqual(linkedRig);
      expect(mocks.hdr.mock.calls[0][1]).toBe('/content/sky.hdr');
      expect(h.boot.contentOnScreen).toBe(true);
      expect(h.canvas.dataset).toMatchObject({ look: 'second', variant: 'dark', scene: 'loading' });
      h.boot.drawFrame();
      expect(h.render).toHaveBeenLastCalledWith(room.scene, room.camera);
      expect(h.canvas.dataset.scene).toBe('ready');
      expect(performance.getEntriesByName('first-frame')).toHaveLength(1);
    },
  );

  it.each(['rotunda', 'plinth', 'look', 'look-default-variant', 'lighting', 'statics-and-look', 'both'] as const)(
    'retains the original failure state and priority: %s', async (failure) => {
      const h = harness();
      await h.started();
      const lookError = new Error('look failed');
      const staticError = new Error('static failed');
      const lightingError = new Error('fallback failed');
      if (failure === 'look-default-variant') {
        h.assets.look.parser.getDependency = vi.fn(async () => { throw lookError; });
      }
      if (failure === 'look' || failure === 'statics-and-look' || failure === 'both') h.pending.look.reject(lookError);
      else h.resolve('look');
      if (failure === 'rotunda' || failure === 'plinth' || failure === 'statics-and-look' || failure === 'both') {
        h.pending[failure === 'plinth' ? 'plinth' : 'rotunda'].reject(staticError);
        h.pending[failure === 'plinth' ? 'rotunda' : 'plinth'].resolve(
          h.assets[failure === 'plinth' ? 'rotunda' : 'plinth'].gltf,
        );
      } else h.resolve('statics');
      if (failure === 'lighting' || failure === 'both') {
        h.sky.reject(new Error('sky failed'));
        await vi.waitFor(() => expect(mocks.fallback).toHaveBeenCalledTimes(1));
        h.fallback.reject(lightingError);
      } else h.resolve('lighting');
      await h.run;
      expect(h.boot.contentOnScreen).toBe(false);
      expect(h.canvas.dataset.scene).toBe('error');
      expect(h.canvas.dataset.look).toBeUndefined();
      expect(h.lobby.setError).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenLastCalledWith('[archviz] the showroom failed to load',
        failure === 'lighting' || failure === 'both' ? lightingError :
          failure === 'look' || failure === 'look-default-variant' ? lookError : staticError);
      h.boot.drawFrame();
      expect(h.canvas.dataset.scene).toBe('error');
      expect(performance.getEntriesByName('first-frame')).toHaveLength(0);
      expect(h.assets.look.root.parent).toBeNull();
      if (failure === 'lighting') {
        for (const asset of Object.values(h.assets)) expect(asset.disposal).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('keeps variant failure as a warning and an environment failure as the room fallback', async () => {
    const h = harness('?variant=dark&look=unknown', false, false);
    await h.started();
    h.resolve('look'); h.resolve('statics');
    h.sky.reject(new Error('sky failed'));
    await vi.waitFor(() => expect(mocks.fallback).toHaveBeenCalledTimes(1));
    expect(mocks.panel).not.toHaveBeenCalled();
    h.fallback.resolve(h.environment);
    await h.run;
    expect(h.boot.contentOnScreen).toBe(true);
    expect(h.canvas.dataset).toMatchObject({ look: 'first', variant: 'base' });
    expect(h.environment.apply).toHaveBeenCalledWith(h.boot.showroom!.scene,
      daylightParameters(DEFAULT_RIG.daylight).skyIntensity * ROOM_ENVIRONMENT_SCALE,
      daylightParameters(DEFAULT_RIG.daylight).backgroundIntensity);
    expect(console.warn).toHaveBeenCalledWith('[archviz] the look loaded without its variant', expect.any(Error));
    expect(console.error).not.toHaveBeenCalled();
    expect(mocks.hdr).not.toHaveBeenCalled();
    h.boot.drawFrame();
    expect(h.canvas.dataset.scene).toBe('ready');
  });
});
