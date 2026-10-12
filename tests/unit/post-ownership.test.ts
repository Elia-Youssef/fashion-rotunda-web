import {
  AgXToneMapping,
  BufferGeometry,
  HalfFloatType,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  RenderPipeline,
  Scene,
  SRGBColorSpace,
  Texture,
} from 'three/webgpu';
import type { Material, Node, PassNode, RenderTarget, WebGPURenderer } from 'three/webgpu';
import { context, materialMetalness, materialRoughness, normalView, output, velocity } from 'three/tsl';
import GTAONode from 'three/addons/tsl/display/GTAONode.js';
// @ts-expect-error three.js does not publish types for its private CPU cache components.
import RenderContexts from '../../node_modules/three/src/renderers/common/RenderContexts.js';
// @ts-expect-error three.js does not publish types for its private CPU cache components.
import RenderObjects from '../../node_modules/three/src/renderers/common/RenderObjects.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostChain } from '../../src/post/chain';
import type { Backend } from '../../src/post/settings';
import { TIERS } from '../../src/tiers/table';

// Capture real graphs at their output boundary; only drawing is stubbed. Every node, target,
// material and dispose event below comes from the installed three.js implementation.
const captured = vi.hoisted(() => ({
  pipelines: [] as RenderPipeline[],
  lightingInputs: [] as Node[],
  graphInputs: new WeakMap<RenderPipeline, Node[]>(),
}));
vi.mock('three/webgpu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three/webgpu')>();
  return {
    ...actual,
    RenderPipeline: class extends actual.RenderPipeline {
      constructor(...args: ConstructorParameters<typeof actual.RenderPipeline>) {
        super(...args);
        captured.pipelines.push(this);
        captured.graphInputs.set(this, captured.lightingInputs.splice(0));
      }
    },
  };
});

type Resource = RenderTarget | Material | Texture;
type RuntimeNode = Node & {
  isRTTNode?: boolean;
  isPassTextureNode?: boolean;
  isPassNode?: boolean;
  _CoCBlurNode?: Node;
  renderTarget?: RenderTarget;
  autoUpdate?: boolean;
  autoResize?: boolean;
  width?: number | null;
  height?: number | null;
  getResolutionScale?: () => number;
  _quadMesh?: { material: Material };
  beautyNode?: RuntimeNode;
  textureNode?: RuntimeNode;
  node?: Node;
};

function graphNodes(pipeline: RenderPipeline): RuntimeNode[] {
  const visited = new Set<RuntimeNode>();
  function visit(node: RuntimeNode): void {
    if (visited.has(node)) return;
    visited.add(node);
    for (const child of node.getChildren()) visit(child);
    // This private blur owns resources but is not a public shader input of depth of field.
    if (node._CoCBlurNode) visit(node._CoCBlurNode);
  }
  visit(pipeline.outputNode);
  // The AO context is a shader closure; its captured node is not a public child of that closure.
  for (const input of captured.graphInputs.get(pipeline) ?? []) visit(input);
  return [...visited];
}

function disposalCount(resource: Resource): () => number {
  let count = 0;
  resource.addEventListener('dispose', () => { count += 1; });
  return () => count;
}

function observeGraph(pipeline: RenderPipeline) {
  const nodes = graphNodes(pipeline);
  const resources = new Set<Resource>();
  function collect(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (value && typeof value === 'object') {
      if ('isRenderTarget' in value || 'isMaterial' in value || 'isTexture' in value) {
        resources.add(value as Resource);
      } else if ('isQuadMesh' in value && 'material' in value) {
        collect(value.material);
      } else if ('isTextureNode' in value && 'value' in value) {
        // A texture node carries its texture in .value; TRAA's initial depth placeholder is
        // reachable only that way.
        collect((value as { value: unknown }).value);
      }
    }
  }
  for (const node of nodes) Object.values(node).forEach(collect);
  collect((pipeline as unknown as { _quadMesh: object })._quadMesh);
  // Bloom creates its quad materials in setup, which needs only the shared CPU node context.
  // Include those late-created materials too, without compiling or rendering a shader.
  for (const node of nodes) {
    if (node.constructor.name === 'BloomNode') {
      node.setup({ getSharedContext: () => ({}) } as unknown as Parameters<Node['setup']>[0]);
      Object.values(node).forEach(collect);
    }
  }
  // A render target frees its own attachments and its depth texture when it is disposed; those
  // textures never see a dispose event of their own in this renderer-less fixture. Everything
  // else is a standalone texture the graph itself must dispose exactly once.
  const withTarget = new Set<unknown>();
  for (const resource of resources) {
    if ('isRenderTarget' in resource) {
      const target = resource as RenderTarget;
      target.textures.forEach((texture) => withTarget.add(texture));
      if (target.depthTexture !== null) withTarget.add(target.depthTexture);
    }
  }
  const counts = [...resources]
    .filter((resource) => !withTarget.has(resource))
    .map((resource) => ({ resource, count: disposalCount(resource) }));
  expect(counts.some(({ resource }) => 'isRenderTarget' in resource)).toBe(true);
  expect(counts.some(({ resource }) => 'isMaterial' in resource)).toBe(true);
  const inputs = nodes.filter((node) => node.isPassTextureNode);
  const borrowed = inputs.map((node) => vi.spyOn(node, 'dispose'));
  const rtts = nodes.filter((node) => node.isRTTNode);
  return {
    nodes,
    rtts,
    standaloneTextures: counts
      .filter(({ resource }) => 'isTexture' in resource)
      .map(({ resource }) => resource as Texture),
    assertDisposed(times: number): void {
      for (const { resource, count } of counts) {
        expect(count(), `${resource.constructor.name} disposal events`).toBe(times);
      }
      for (const input of borrowed) expect(input).not.toHaveBeenCalled();
    },
  };
}

function fixture(backend: Backend, tier: 'base' | 'mid' | 'high', isTouch = false) {
  const renderer = {
    toneMapping: AgXToneMapping,
    outputColorSpace: SRGBColorSpace,
    backend: { isWebGPUBackend: backend === 'webgpu' },
    getPixelRatio: () => 1,
    getDrawingBufferSize: (size: { set: (w: number, h: number) => unknown }) => size.set(128, 72),
  } as unknown as WebGPURenderer;
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const geometry = new BufferGeometry();
  const material = new MeshStandardMaterial();
  material.map = new Texture();
  scene.add(new Mesh(geometry, material));
  const shared = [vi.spyOn(geometry, 'dispose'), vi.spyOn(material, 'dispose'),
    vi.spyOn(material.map, 'dispose')];
  const options = { renderer, scene, camera, backend, tier: TIERS[tier], isTouch };
  return {
    options,
    assertBorrowed(): void {
      for (const resource of shared) expect(resource).not.toHaveBeenCalled();
    },
  };
}

function latestGraph() {
  return observeGraph(captured.pipelines.at(-1)!);
}

beforeEach(() => {
  captured.pipelines.length = 0;
  captured.lightingInputs.length = 0;
  vi.stubGlobal('location', { search: '' });
  vi.spyOn(RenderPipeline.prototype, 'render').mockImplementation(() => undefined);
  const getAOTexture = GTAONode.prototype.getTextureNode;
  vi.spyOn(GTAONode.prototype, 'getTextureNode').mockImplementation(function (this: GTAONode) {
    captured.lightingInputs.push(this);
    return getAOTexture.call(this);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const profiles = [
  { backend: 'webgpu', tier: 'base', rtts: 0 },
  { backend: 'webgl2', tier: 'base', rtts: 0 },
  { backend: 'webgpu', tier: 'mid', rtts: 1 },
  { backend: 'webgl2', tier: 'mid', rtts: 1 },
  { backend: 'webgpu', tier: 'high', rtts: 2 },
  { backend: 'webgl2', tier: 'high', rtts: 1 },
] as const;

describe('post graph resource ownership', () => {
  it.each(profiles)('$tier/$backend frees every target and material once on disposal and reconstruction',
    ({ backend, tier, rtts }) => {
      const sample = fixture(backend, tier);
      const retired = [];
      for (let rebuild = 0; rebuild < 3; rebuild += 1) {
        const chain = createPostChain(sample.options);
        const graph = latestGraph();
        expect(graph.rtts).toHaveLength(rtts);
        // Both factories must consume the exact conversion node, with the default full-size RTT.
        for (const input of graph.rtts) {
          expect(input.renderTarget?.texture.type).toBe(HalfFloatType);
          expect(input.autoResize).toBe(true);
          expect(input.autoUpdate).toBe(true);
          expect(input.width).toBeNull();
          expect(input.height).toBeNull();
          expect(input.getResolutionScale?.()).toBe(1);
          expect(graph.nodes.some((effect) => effect.beautyNode === input || effect.textureNode === input))
            .toBe(true);
        }
        chain.setSize(256, 144);
        graph.assertDisposed(0);
        chain.dispose();
        graph.assertDisposed(1);
        chain.dispose();
        graph.assertDisposed(1);
        retired.push(graph);
        for (const old of retired) old.assertDisposed(1);
        sample.assertBorrowed();
      }
    });

  it.each(profiles.filter((profile) => profile.rtts > 0))(
    '$tier/$backend retires the failed graph once and keeps fallback disposal idempotent',
    ({ backend, tier }) => {
      const sample = fixture(backend, tier);
      const chain = createPostChain(sample.options);
      const failed = latestGraph();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.mocked(RenderPipeline.prototype.render).mockImplementationOnce(() => { throw new Error('draw failed'); });
      chain.render();
      expect(chain.fellBack).toBe(true);
      failed.assertDisposed(1);
      const fallback = latestGraph();
      expect(fallback.rtts).toHaveLength(0);
      chain.render();
      fallback.assertDisposed(0);
      failed.assertDisposed(1);
      chain.dispose();
      chain.dispose();
      fallback.assertDisposed(1);
      failed.assertDisposed(1);
      sample.assertBorrowed();
    });

  it.each(profiles)('$tier/$backend leaves no old-graph texture undisposed across a rebuild',
    ({ backend, tier }) => {
      const sample = fixture(backend, tier);
      const retired = createPostChain(sample.options);
      const retiredGraph = latestGraph();
      expect(retiredGraph.standaloneTextures.length).toBeGreaterThan(0);
      if (retiredGraph.nodes.some((node) => node.constructor.name === 'TRAANode')) {
        // The 1x1 depth TRAA samples before its first resolved frame; TRAANode.dispose omits it.
        expect(retiredGraph.standaloneTextures.some((texture) => 'isDepthTexture' in texture))
          .toBe(true);
      }
      // The rebuild the composition root performs on a canvas-box change: build the replacement
      // first, then dispose the retired chain.
      const active = createPostChain(sample.options);
      const activeGraph = latestGraph();
      retiredGraph.assertDisposed(0);
      retired.dispose();
      retiredGraph.assertDisposed(1);
      activeGraph.assertDisposed(0);
      active.dispose();
      activeGraph.assertDisposed(1);
      retired.dispose();
      retiredGraph.assertDisposed(1);
      sample.assertBorrowed();
    });

  it('retires every High WebGPU resource once on each governor rebuild', () => {
    const sample = fixture('webgpu', 'high');
    const chain = createPostChain(sample.options);
    const retired = [latestGraph()];
    let now = 0;
    for (const level of ['no-ssr', 'base']) {
      for (let frame = 0; frame < 120; frame += 1) {
        chain.governorHarness!.observe(100, now, false);
        now += 100;
      }
      expect(chain.governorState?.level).toBe(level);
      chain.render();
      for (const graph of retired) graph.assertDisposed(1);
      const active = latestGraph();
      active.assertDisposed(0);
      retired.push(active);
    }
    chain.dispose();
    chain.dispose();
    for (const graph of retired) graph.assertDisposed(1);
    sample.assertBorrowed();
  });

  it('borrows the scene texture directly when TRAA has no composite to convert', () => {
    vi.stubGlobal('location', { search: '?post=aa' });
    const sample = fixture('webgpu', 'mid');
    const chain = createPostChain(sample.options);
    const graph = latestGraph();
    expect(graph.rtts).toHaveLength(0);
    const traa = graph.nodes.find((node) => node.constructor.name === 'TRAANode')!;
    expect(traa.beautyNode?.isPassTextureNode).toBe(true);
    chain.dispose();
    chain.dispose();
    graph.assertDisposed(1);
    sample.assertBorrowed();
  });

  it('owns the depth-of-field conversion when finishing runs without TRAA', () => {
    vi.stubGlobal('location', { search: '?post=finish' });
    const sample = fixture('webgpu', 'high');
    const chain = createPostChain(sample.options);
    const graph = latestGraph();
    expect(graph.rtts).toHaveLength(1);
    expect(graph.nodes.some((node) => node.constructor.name === 'TRAANode')).toBe(false);
    const dof = graph.nodes.find((node) => node.constructor.name === 'DepthOfFieldNode')!;
    expect(dof.textureNode).toBe(graph.rtts[0]);
    chain.dispose();
    chain.dispose();
    graph.assertDisposed(1);
    sample.assertBorrowed();
  });

  it('does not recreate or use a disposed graph after the chain retires', () => {
    const sample = fixture('webgpu', 'high');
    const chain = createPostChain(sample.options);
    const graph = latestGraph();
    chain.dispose();
    chain.render();
    chain.setSize(256, 144);
    expect(RenderPipeline.prototype.render).not.toHaveBeenCalled();
    expect(captured.pipelines).toHaveLength(1);
    graph.assertDisposed(1);
    sample.assertBorrowed();
  });
});

describe('post MRT context reuse', () => {
  it.each(['webgpu', 'webgl2'] as const)('%s keeps scene records bounded across mixed-layout rebuilds',
    (backend) => {
      const sample = fixture(backend, 'mid');
      const renderer = Object.assign(sample.options.renderer, {
        getClearDepth: () => 1,
        getClearStencil: () => 0,
        contextNode: context({}),
        _currentSourceMaterial: null,
      });
      const contexts = new RenderContexts(renderer);
      const releases = vi.fn();
      const objects = new RenderObjects(renderer, { getCacheKey: () => 0, delete: releases }, {},
        { delete: releases }, { deleteForRender: releases }, {});
      const mesh = sample.options.scene.children[0] as Mesh;
      const lights = {};
      const expectedContexts = backend === 'webgpu' ? 3 : 2;
      for (let rebuild = 0; rebuild < 6; rebuild += 1) {
        const tier = rebuild % 2 === 0 ? TIERS.mid : TIERS.high;
        const chain = createPostChain({ ...sample.options, tier });
        const nodes = graphNodes(captured.pipelines.at(-1)!);
        for (const passNode of nodes.filter((node) => node.isPassNode) as PassNode[]) {
          const mrtNode = passNode.getMRT()!;
          const outputs = (mrtNode as unknown as { outputNodes: Record<string, Node> }).outputNodes;
          const isBeauty = 'velocity' in outputs;
          const expected = isBeauty ? { output, velocity } :
            'metalness' in outputs ? { output: normalView, metalness: materialMetalness,
              roughness: materialRoughness } : { output: normalView };
          expect(outputs).toEqual(expected);
          const renderContext = contexts.get(passNode.renderTarget, mrtNode);
          objects.get(mesh, mesh.material, sample.options.scene, sample.options.camera,
            lights, renderContext, null);
        }
        chain.dispose();
        // Warm every layout once, then require actual cache cardinality to stay constant.
        if (rebuild >= 1) {
          expect(Object.keys(contexts._renderContexts)).toHaveLength(expectedContexts);
          expect(objects._renderObjects.size).toBe(expectedContexts);
        }
      }
      // Layout nodes contain only shared shader outputs; graph disposal never retires them.
      sample.assertBorrowed();
      if (mesh.material instanceof MeshStandardMaterial) mesh.material.dispose();
      expect(objects._renderObjects.size).toBe(0);
      expect(releases).toHaveBeenCalledTimes(expectedContexts * 3);
      contexts.dispose();
    });
});
