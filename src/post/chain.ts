// Ambient occlusion, anti-aliasing, screen-space global
// illumination, screen-space reflections, bloom, color grade, vignette and depth of field through
// the node post chain of three 0.186.0, governed by frame work time.
//
// The chain replaces renderer.render for every frame after the showroom exists:
// 1. A pre-pass for normals, depth, metalness and roughness.
// 2. GTAO at half resolution composited through the lighting context (builtinAOContext).
// 3. The scene pass that carries beauty and, when TRAA is on, a velocity attachment.
// 4. SSGI computing diffuse bounce illumination from the scene pass beauty, normal and depth.
// 5. SSR computing specular screen-space reflections from beauty, normal, depth, metalness, roughness.
// 6. Bloom extracted from the HDR beauty above luminance 1.15 and added back to the HDR composite.
// 7. Composite of beauty + GI + SSR + bloom fed to TRAA (reprojected along velocity) or MSAA.
// 8. Depth of field applied to the anti-aliased beauty on high tier at rest on WebGPU.
// 9. Tone mapping (AgX) and output color space conversion (sRGB) transforming HDR to display space.
// 10. Color grade through a 3D LUT (Data3DTexture) applied in display space.
// 11. Aspect-aware vignette darkening the corners by at most 0.25 in display space.
// 12. Output quad rendered through RenderPipeline with outputColorTransform disabled.
//
// The chain owns no DOM: what it turned on is read back through `features`, and the composition
// root is the one place that writes it onto the canvas.
//
// Source references below are to three.js 0.186.0 under node_modules/three/ and are quoted with
// file and line.

import {
  ClampToEdgeWrapping,
  Data3DTexture,
  LinearFilter,
  RenderPipeline,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three/webgpu';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { lut3D } from 'three/addons/tsl/display/Lut3DNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import {
  builtinAOContext,
  convertToTexture,
  float,
  materialMetalness,
  materialRoughness,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  screenUV,
  smoothstep,
  texture3D,
  uniform,
  vec2,
  vec4,
  velocity,
} from 'three/tsl';
import type GTAONode from 'three/addons/tsl/display/GTAONode.js';
import type TRAANode from 'three/addons/tsl/display/TRAANode.js';
import type SSGINode from 'three/addons/tsl/display/SSGINode.js';
import type SSRNode from 'three/addons/tsl/display/SSRNode.js';
import type BloomNode from 'three/addons/tsl/display/BloomNode.js';
import type DepthOfFieldNode from 'three/addons/tsl/display/DepthOfFieldNode.js';
import type { SSRNodeOptions } from 'three/addons/tsl/display/SSRNode.js';
import type { PerspectiveCamera, Scene } from 'three';
import type { Node, PassNode, Texture, UniformNode, WebGPURenderer } from 'three/webgpu';
import type RTTNode from 'three/src/nodes/utils/RTTNode.js';

import { postSettingsFor, settingsForLevel } from './settings';
import type { Backend, PostSettings } from './settings';
import type { TierSettings } from '../tiers/table';
import { createGovernor, governorOperates } from './governor';
import type { EnhancedLevel, Governor, GovernorDiagnostics, GovernorState } from './governor';
import { gradeLut, LUT_SIZE } from './grade';

export interface PostChainOptions {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  tier: TierSettings;
  /** True on a touch device; the base tier's AO is desktop only. */
  isTouch: boolean;
  backend: Backend;
  /**
   * Asks the composition root for one more frame. The SSGI resolution and the governor's level
   * are applied inside render(), so a change decided while the loop is idle needs a frame drawn
   * for it to reach the screen. The composition root passes `() => loop.invalidate()`.
   */
  requestFrame?: () => void;
  /** Governor decision carried across a CSS-box graph rebuild; omitted for a fresh session. */
  governorState?: GovernorState;
  /**
   * Whether recovery may qualify when the chain is created, so a rebuild between two frames
   * never lets an ineligible sample clear the qualification the old chain had accumulated.
   * The composition root computes it from page lifecycle facts; the chain additionally
   * requires that it has not fallen back.
   */
  recoveryEligible?: boolean;
  /**
   * Test-only (?e2e=1): start with real-frame governor sampling blocked. The composition root
   * carries it across a rebuild so an injected deterministic sequence stays the only input.
   */
  deterministicSampling?: boolean;
  /** Where the depth of field focuses: the look on the plinth; default [0, 1, 0]. */
  focusTarget?: [number, number, number];
}

export interface PostChain {
  /** Draws one frame through the chain; the loop's replacement for renderer.render. */
  render(): void;
  /** True when the chain does more than pass the beauty through. */
  readonly active: boolean;
  /**
   * What is on: ao, traa, msaa, ssgi, ssr, bloom, lut, vignette, dof. The chain owns the returned
   * record and reuses it until a published value would change (a graph rebuild, a fallback, or a
   * motion or depth-of-field transition), so readers can key on the record identity; they must
   * copy it, never mutate it.
   */
  readonly features: {
    ao: boolean;
    traa: boolean;
    msaa: boolean;
    ssgi: 'off' | 'half' | 'full';
    ssr: boolean;
    bloom: boolean;
    lut: boolean;
    vignette: boolean;
    /** 'off': not built or not allowed; 'ready': built and allowed, camera moving; 'on': drawing. */
    dof: 'off' | 'ready' | 'on';
  };
  /** Feeds the loop's frame work time to the governor; the composition root calls it from onFrameTime. */
  observeFrame(workMs: number): void;
  /** Camera motion gates depth of field while TRAA maintains the moving frame history. */
  notifyMotion(): void;
  /** False in walkthrough mode; main.ts wires the camera's mode callback to it. */
  setDepthOfFieldAllowed(allowed: boolean): void;
  /** Call on every canvas size or pixel ratio change. */
  setSize(width: number, height: number): void;
  /** Full governor state for a CSS-box graph rebuild, or null when the governor is disabled. */
  readonly governorState: GovernorState | null;
  /** Committed governor record for the proof panel and the canvas attributes; null when disabled. */
  readonly governorDiagnostics: GovernorDiagnostics | null;
  /** A runtime post failure has committed this chain to pass-through until the page reloads. */
  readonly fellBack: boolean;
  /**
   * Recovery eligibility, driven by the composition root from page lifecycle facts (loaded,
   * revealed, visible, no renderer error). The chain combines it with its own fallback state.
   */
  setRecoveryEligible(eligible: boolean): void;
  /**
   * Test-only deterministic control, reachable solely through the guarded `?e2e=1` handle in the
   * composition root. It injects observations through the same state machine; it can never
   * assign a level directly, and it never exists on a production page.
   */
  readonly governorHarness: GovernorTestHarness | null;
  dispose(): void;
}

/** The narrow surface the e2e governor tests drive; see PostChain.governorHarness. */
export interface GovernorTestHarness {
  /** Blocks real-frame samples so the injected sequence is the governor's only input. */
  setDeterministic(on: boolean): void;
  /** Injects one synthetic observation with explicit workMs, nowMs and recovery eligibility. */
  observe(workMs: number, nowMs: number, eligible: boolean): GovernorDiagnostics | null;
}

/**
 * A fallback graph is already pass-through and has no temporal resources to recreate. Rebuilding
 * it after a CSS resize would resurrect the effects that just failed, so the composition root must
 * retain it and forward only its new size.
 */
export function postChainRebuildAllowed(fellBack: boolean): boolean {
  return !fellBack;
}

/** What a tier that asks for nothing renders with: the beauty, straight to the output quad. */
const PASS_THROUGH: PostSettings = {
  ao: false,
  aoHalfResolution: false,
  traa: false,
  msaa: false,
  samples: 0,
  ssgi: 'off',
  ssr: false,
  bloom: false,
  lut: false,
  vignette: false,
  dof: 'off',
};

/** How long after the last motion notification the camera still counts as moving. */
const MOTION_MS = 500;

/** How long after arming the stable rest callback re-checks the rest deadline. */
const MOTION_REST_DELAY_MS = MOTION_MS + 10;

/**
 * The depth-of-field bokeh scale while the camera rests. Halved from 2.5 on 2026-09-23 at the
 * client's request that the at-rest view blur half as much. In DepthOfFieldNode.js the scale only
 * multiplies the blur taps' step (`invSize * bokehScale * CoC`, lines 405 and 437); the CoC
 * (line 376) and the composite blend `min(CoC, 0.5) * 2` (lines 471-472) do not read it, so the
 * sampling disc and the 16-tap max filter's reach halve while where the blur begins stays the same.
 * Both blur passes run at half resolution and are upsampled (lines 251-257), which adds a fixed
 * softening of about 1 px the scale does not control, so the result is less than twice as sharp.
 */
export const DOF_BOKEH_SCALE = 1.25;

type SsgiFactory = typeof import('three/addons/tsl/display/SSGINode.js')['ssgi'];
let ssgiFactory: SsgiFactory | null = null;
let ssgiReady: Promise<void> | null = null;

/** Prepare the diagnostic factory once; render, resize and recovery remain synchronous. */
export function preparePostChain(
  options: Pick<PostChainOptions, 'tier' | 'isTouch' | 'backend'>,
): Promise<void> | null {
  const { settings } = applyDevSwitch(postSettingsFor(options.tier, options.isTouch, options.backend), options.backend);
  if (settings.ssgi === 'off') return null;
  ssgiReady ??= import('three/addons/tsl/display/SSGINode.js').then(({ ssgi }) => {
    ssgiFactory = ssgi;
  });
  return ssgiReady;
}

/**
 * `?post=` forces a slice of the chain for development: off, ao, aa, gi, ssr, finish or max.
 * `finish` enables bloom, lut, vignette and dof allowed without heavy compute passes.
 * `max` enables everything the tier allows on this backend with the governor disabled.
 */
function applyDevSwitch(
  tier: PostSettings,
  backend: Backend,
): { settings: PostSettings; governorEnabled: boolean } {
  const wanted = new URLSearchParams(location.search).get('post');
  if (wanted === 'off') {
    return { settings: PASS_THROUGH, governorEnabled: false };
  }
  if (wanted === 'ao') {
    return {
      settings: { ...PASS_THROUGH, ao: true, aoHalfResolution: true },
      governorEnabled: false,
    };
  }
  if (wanted === 'aa') {
    return {
      settings: {
        ...PASS_THROUGH,
        traa: tier.traa,
        msaa: tier.msaa,
        samples: tier.samples,
      },
      governorEnabled: false,
    };
  }
  if (wanted === 'gi') {
    return {
      settings: {
        ...PASS_THROUGH,
        // SSGINode.useTemporalFiltering defaults to true (SSGINode.js line 193) and leans on the
        // TRAA downstream to resolve its jittered slices, so the slice keeps the tier's TRAA
        // instead of showing SSGI without the filter it was written against.
        traa: tier.traa,
        // Explicit diagnostic override. The normal High preset disables the raw SSGI result
        // until it can be denoised without visible wall/fabric grain.
        ssgi: backend === 'webgpu' ? 'full-with-half-fallback' : 'off',
      },
      governorEnabled: false,
    };
  }
  if (wanted === 'ssr') {
    return {
      settings: {
        ...PASS_THROUGH,
        traa: tier.traa,
        ssr: backend === 'webgpu' && tier.ssr,
      },
      governorEnabled: false,
    };
  }
  if (wanted === 'finish') {
    return {
      settings: {
        ...PASS_THROUGH,
        bloom: tier.bloom,
        lut: tier.lut,
        vignette: tier.vignette,
        dof: backend === 'webgpu' ? tier.dof : 'off',
      },
      governorEnabled: false,
    };
  }
  if (wanted === 'max') {
    return {
      settings: {
        ...tier,
        ssgi: backend === 'webgpu' ? tier.ssgi : 'off',
        ssr: backend === 'webgpu' && tier.ssr,
        dof: backend === 'webgpu' ? tier.dof : 'off',
      },
      governorEnabled: false,
    };
  }
  const governorEnabled = governorOperates(backend, tier, wanted !== null);
  return { settings: tier, governorEnabled };
}

/** The backend label for the fallback warning, read the way create.ts reads it. */
function backendName(renderer: WebGPURenderer): string {
  const backend: object = renderer.backend;
  return 'isWebGPUBackend' in backend && backend.isWebGPUBackend === true ? 'webgpu' : 'webgl2';
}

/** SSGINode in three.js 0.186.0 defines setSize at SSGINode.js line 343, but @types/three omits it. */
interface SSGINodeWithSize extends SSGINode {
  setSize(width: number, height: number): void;
}

/**
 * BloomNode in three.js 0.186.0 defines getTextureNode at BloomNode.js line 284, but BloomNode.d.ts
 * line 28 declares getTexture.
 */
interface BloomNodeWithTextureNode extends BloomNode {
  getTextureNode(): Node<'vec4'>;
}

/**
 * DepthOfFieldNode in three.js 0.186.0 defines setSize at DepthOfFieldNode.js line 242,
 * but DepthOfFieldNode.d.ts lines 3-18 omits setSize.
 */
interface DepthOfFieldNodeFull extends DepthOfFieldNode {
  setSize(width: number, height: number): void;
}

/**
 * TRAANode in three.js 0.186.0 samples a 1x1 depth placeholder until its first resolved frame
 * rebinds that sampler to the history depth (TRAANode.js lines 237 and 426-428). The placeholder is
 * a standalone depth texture: it belongs to no render target, so target disposal cannot free it,
 * and TRAANode.dispose at TRAANode.js line 613 frees the history and resolve targets and the
 * resolve material but not the placeholder. TRAANode.d.ts omits the field.
 */
interface TRAANodePlaceholderDepth extends TRAANode {
  /** Private in three.js; optional so a version without it leaves nothing to free instead of throwing. */
  readonly _previousDepthNode?: { value: Texture | null };
}

/**
 * Builds the 3D texture containing the showroom's warm grade LUT.
 * UnsignedByteType with LinearFilter ensures hardware filtering across both WebGPU and WebGL2.
 */
function createLutTexture(): Data3DTexture {
  const raw = gradeLut(LUT_SIZE);
  const data = new Uint8Array(LUT_SIZE * LUT_SIZE * LUT_SIZE * 4);
  for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
    data[j] = Math.round(Math.min(1, Math.max(0, raw[i]!)) * 255);
    data[j + 1] = Math.round(Math.min(1, Math.max(0, raw[i + 1]!)) * 255);
    data[j + 2] = Math.round(Math.min(1, Math.max(0, raw[i + 2]!)) * 255);
    data[j + 3] = 255;
  }
  const texture = new Data3DTexture(data, LUT_SIZE, LUT_SIZE, LUT_SIZE);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.wrapR = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * These layouts contain only shared shader outputs, never a graph's textures or uniforms.
 * Keep their identities for the renderer's lifetime: RenderContexts keys by MRT id, so new ids
 * for the same layout would retain another set of persistent scene render objects on every rebuild.
 */
const mrtLayouts = new WeakMap<WebGPURenderer, {
  beauty: ReturnType<typeof mrt>;
  normals: ReturnType<typeof mrt>;
  reflections: ReturnType<typeof mrt>;
}>();

function layoutsFor(renderer: WebGPURenderer): NonNullable<ReturnType<typeof mrtLayouts.get>> {
  let layouts = mrtLayouts.get(renderer);
  if (layouts === undefined) {
    layouts = {
      beauty: mrt({ output, velocity }),
      normals: mrt({ output: normalView }),
      reflections: mrt({ output: normalView, metalness: materialMetalness, roughness: materialRoughness }),
    };
    mrtLayouts.set(renderer, layouts);
  }
  return layouts;
}

/**
 * The graph behind one settings choice: null fields are features that are off, so dispose walks
 * exactly what was allocated.
 */
interface ChainGraph {
  pipeline: RenderPipeline;
  settings: PostSettings;
  scenePass: PassNode;
  prePass: PassNode | null;
  gtao: GTAONode | null;
  traaNode: TRAANode | null;
  /** The 1x1 depth TRAANode samples before its first resolved frame; see TRAANodePlaceholderDepth. */
  traaPreviousDepth: Texture | null;
  ssgiNode: SSGINodeWithSize | null;
  ssrNode: SSRNode | null;
  bloomNode: BloomNodeWithTextureNode | null;
  dofNode: DepthOfFieldNodeFull | null;
  dofActiveUniform: UniformNode<'float', number> | null;
  focusDistanceUniform: UniformNode<'float', number> | null;
  bokehScaleUniform: UniformNode<'float', number> | null;
  aspectUniform: UniformNode<'float', number>;
  lutTexture: Data3DTexture | null;
  /** Only conversions allocated by this graph, never borrowed texture/pass inputs. */
  ownedRTTs: Set<RTTNode>;
  disposed: boolean;
  /** Bloom creates its internal blur targets during the first render. */
  hasRendered: boolean;
}

export function createPostChain(options: PostChainOptions): PostChain {
  const { renderer, scene, camera, backend } = options;
  const requestFrame = options.requestFrame;
  const dev = applyDevSwitch(postSettingsFor(options.tier, options.isTouch, backend), backend);
  const settings = dev.settings;
  const layouts = layoutsFor(renderer);
  let disposed = false;

  let governor: Governor | null = null;
  if (dev.governorEnabled) {
    governor = createGovernor({
      budgetMs: options.tier.frameBudgetMs,
      windowFrames: 60,
      patience: 2,
      ssgiEnabled: settings.ssgi !== 'off',
      ...(options.governorState === undefined ? {} : { initialState: options.governorState }),
    });
  }
  let fellBack = false;
  // Start false and apply the supplied gate below. That makes an ineligible reconstruction clear
  // a carried recovery stream instead of silently retaining it because both values happened to be
  // false at construction time.
  let recoveryEligible = false;
  let deterministicSampling = options.deterministicSampling === true;

  /**
   * The one gate behind the interface method, the construction option and the fallback path:
   * recovery qualification exists only while every lifecycle fact holds, and losing it clears
   * the accumulated run immediately rather than at the next sample.
   */
  function applyRecoveryEligible(eligible: boolean): void {
    const combined = eligible && governor !== null && !fellBack;
    recoveryEligible = combined;
    if (!combined) {
      governor?.invalidateRecovery();
    }
  }

  let lastMotionTimestamp = 0;
  let currentSSGIScale = 1.0;
  let depthOfFieldAllowed = true;
  const focusTarget = new Vector3(...(options.focusTarget ?? [0, 1, 0]));
  const focusDirection = new Vector3();
  const focusOffset = new Vector3();

  /** DepthOfFieldNode expects distance along the camera's look direction, not radial distance. */
  function focusDistance(): number {
    camera.getWorldDirection(focusDirection);
    focusOffset.copy(focusTarget).sub(camera.position);
    return Math.max(camera.near, focusOffset.dot(focusDirection));
  }

  function currentLevel(): EnhancedLevel {
    return governor?.level ?? 'full';
  }

  /** Full SSGI at the top of the ladder; half only after a frame-budget downgrade. */
  function wantedSSGIScale(): number {
    return currentLevel() === 'full' ? 1.0 : 0.5;
  }

  /**
   * settingsForLevel copies the settings record for every degraded level, and the governor can sit
   * on one level for thousands of rendered frames, so this chain derives each level of its ladder
   * once and reuses the record. The map is created per chain instance: two chains never share
   * derived settings, and no reader mutates a settings record after it is built.
   */
  const levelSettings = new Map<EnhancedLevel, PostSettings>();

  function settingsForCurrentLevel(): PostSettings {
    const level = currentLevel();
    let derived = levelSettings.get(level);
    if (derived === undefined) {
      derived = settingsForLevel(settings, level);
      levelSettings.set(level, derived);
    }
    return derived;
  }

  function scenePassFor(wanted: PostSettings): PassNode {
    if (wanted.ao || wanted.traa || wanted.msaa || wanted.ssgi !== 'off' || wanted.ssr) {
      return pass(scene, camera, { samples: wanted.msaa ? 4 : 0 });
    }
    return pass(scene, camera);
  }

  function buildGraph(wanted: PostSettings): ChainGraph {
    const scenePass = scenePassFor(wanted);
    const ownedRTTs = new Set<RTTNode>();

    // Use the same conversion as the effect factories, but keep ownership when it allocates.
    // Existing samplers, textures and pass outputs stay borrowed, even if they are RTTs already.
    function effectTexture(input: Node<'vec4'>): ReturnType<typeof convertToTexture> {
      const converted = convertToTexture(input);
      if (converted !== input && converted.isRTTNode === true) {
        ownedRTTs.add(converted);
      }
      return converted;
    }

    let prePass: PassNode | null = null;
    let gtao: GTAONode | null = null;
    let ssgiNode: SSGINodeWithSize | null = null;
    let ssrNode: SSRNode | null = null;
    let bloomNode: BloomNodeWithTextureNode | null = null;
    let dofNode: DepthOfFieldNodeFull | null = null;
    let traaPreviousDepth: Texture | null = null;
    let dofActiveUniform: UniformNode<'float', number> | null = null;
    let focusDistanceUniform: UniformNode<'float', number> | null = null;
    let bokehScaleUniform: UniformNode<'float', number> | null = null;
    let lutTexture: Data3DTexture | null = null;
    const aspectUniform = uniform(1.0);

    const needsPrePass = wanted.ao || wanted.ssgi !== 'off' || wanted.ssr;
    if (needsPrePass) {
      prePass = pass(scene, camera, { samples: 0 });
      if (wanted.ssr) {
        // SSR requires metalness and roughness attachments to determine reflection specular lobes
        // and dielectric vs metal response. Extending the pre-pass MRT avoids a third geometry pass.
        prePass.setMRT(layouts.reflections);
      } else {
        prePass.setMRT(layouts.normals);
      }

      if (wanted.ao) {
        gtao = ao(prePass.getTextureNode('depth'), prePass.getTextureNode(), camera);
        gtao.resolutionScale = wanted.aoHalfResolution ? 0.5 : 1;
        scenePass.contextNode = builtinAOContext(gtao.getTextureNode().sample(screenUV).r);
      }
    }

    if (wanted.traa) {
      scenePass.setMRT(layouts.beauty);
    }

    if (wanted.ssgi !== 'off' && prePass !== null) {
      // SSGINode computes horizon-based diffuse bounce illumination from beauty, depth and normal.
      if (ssgiFactory === null) throw new Error('SSGI diagnostic was not prepared');
      const rawSSGI = ssgiFactory(
        scenePass.getTextureNode(),
        prePass.getTextureNode('depth'),
        prePass.getTextureNode(),
        camera,
      ) as SSGINodeWithSize;
      // The diagnostic keeps Three's medium temporal preset and reduced strength for later
      // denoising work. It still grains walls at client resolution, so normal High leaves it off.
      rawSSGI.sliceCount.value = 2;
      rawSSGI.stepCount.value = 8;
      rawSSGI.giIntensity.value = 3;
      // SSGINode.updateBefore (SSGINode.js lines 365-366) calls this.setSize with the full drawing
      // buffer on every frame, so the resolution switch has to live in the instance's own setSize
      // rather than in a field the node would overwrite.
      const rawSetSize = rawSSGI.setSize.bind(rawSSGI);
      rawSSGI.setSize = (w: number, h: number): void => {
        rawSetSize(
          Math.max(1, Math.round(w * currentSSGIScale)),
          Math.max(1, Math.round(h * currentSSGIScale)),
        );
      };
      ssgiNode = rawSSGI;
    }

    if (wanted.ssr && prePass !== null) {
      // SSRNode traces reflections across the marble floor and brass inlays.
      const ssrOptions: SSRNodeOptions = {
        metalnessNode: prePass.getTextureNode('metalness').r,
        roughnessNode: prePass.getTextureNode('roughness').r,
        reflectNonMetals: true,
        camera,
      };
      // SSRNode.d.ts requires vec3; SSRNode.js:1142 samples this texture's RGB, so retain the sampler.
      const ssrNormalNode = prePass.getTextureNode() as unknown as Node<'vec3'>;
      ssrNode = ssr(
        scenePass.getTextureNode(),
        prePass.getTextureNode('depth'),
        ssrNormalNode,
        ssrOptions,
      );
      // A maximum reflection distance of 12 m spans across the rotunda plinth and floor.
      ssrNode.maxDistance.value = 12;
      ssrNode.thickness.value = 0.5;
    }

    if (wanted.bloom) {
      // Bloom is extracted from the HDR beauty before tone mapping with a threshold > 1.0,
      // so only super-white elements (sun disc through dome, brass specular peaks) bloom.
      bloomNode = bloom(
        scenePass.getTextureNode(),
        0.15,
        0.4,
        1.15,
      ) as BloomNodeWithTextureNode;
    }

    // Composite beauty with GI, SSR and bloom in linear HDR before TRAA and tone mapping.
    let compositeColor: Node<'vec4'> | null = null;
    const needsComposite = ssgiNode !== null || ssrNode !== null || bloomNode !== null;
    if (needsComposite) {
      const beautyColor = scenePass.getTextureNode();
      let rgb: Node<'vec3'> = beautyColor.rgb;
      if (ssgiNode !== null) {
        rgb = rgb.add(ssgiNode.getGINode());
      }
      if (ssrNode !== null) {
        rgb = rgb.add(ssrNode.getTextureNode().rgb);
      }
      if (bloomNode !== null) {
        rgb = rgb.add(bloomNode.getTextureNode().rgb);
      }
      compositeColor = vec4(rgb, beautyColor.a);
    }

    let traaNode: TRAANode | null = null;
    if (wanted.traa) {
      // TRAA reprojects the composite history along velocity vectors, providing temporal stability
      // and denoising for both SSGI and SSR.
      traaNode = traa(
        effectTexture(compositeColor ?? scenePass.getTextureNode()),
        scenePass.getTextureNode('depth'),
        scenePass.getTextureNode('velocity'),
        camera,
      );
      // The node's own disposal misses this placeholder, so the graph that owns the node retires
      // it; read it now, before the first resolved frame rebinds the sampler.
      traaPreviousDepth = (traaNode as TRAANodePlaceholderDepth)._previousDepthNode?.value ?? null;
    }

    const beautyInput = traaNode ?? compositeColor ?? scenePass.getTextureNode();

    let beautyAfterDoF: Node<'vec4'> = beautyInput;
    if (wanted.dof !== 'off' && backend === 'webgpu') {
      const viewZ = scenePass.getViewZNode();
      focusDistanceUniform = uniform(focusDistance());
      bokehScaleUniform = uniform(DOF_BOKEH_SCALE);
      dofActiveUniform = uniform(0.0);

      dofNode = dof(
        effectTexture(beautyInput),
        viewZ,
        focusDistanceUniform,
        3.0,
        bokehScaleUniform,
      ) as DepthOfFieldNodeFull;
      // DepthOfFieldNode.d.ts omits TempNode<'vec4'>; DepthOfFieldNode.js:37 calls super('vec4').
      beautyAfterDoF = mix(beautyInput, dofNode as unknown as Node<'vec4'>, dofActiveUniform);
    }

    // Tone mapping and output color transform: brings linear HDR into display space [0, 1].
    const displayNode = renderOutput(beautyAfterDoF, renderer.toneMapping, renderer.outputColorSpace);

    let lutGradedNode: Node<'vec4'> | null = null;
    if (wanted.lut) {
      lutTexture = createLutTexture();
      // Lut3DNode.d.ts omits TempNode<'vec4'>; Lut3DNode.js:28 calls super('vec4').
      lutGradedNode = lut3D(
        displayNode,
        texture3D(lutTexture),
        LUT_SIZE,
        float(1.0),
      ) as unknown as Node<'vec4'>;
    }

    let vignettedNode: Node<'vec4'> | null = null;
    if (wanted.vignette) {
      const baseDisplay = lutGradedNode ?? displayNode;
      const uvOffset = screenUV.sub(vec2(0.5, 0.5));
      const coord = vec2(uvOffset.x.mul(aspectUniform), uvOffset.y);
      const maxDist = float(0.5).mul(aspectUniform.mul(aspectUniform).add(1.0).sqrt());
      const dist = coord.length().div(maxDist);
      const factor = float(1.0).sub(float(0.25).mul(smoothstep(0.0, 1.0, dist)));
      vignettedNode = vec4(baseDisplay.rgb.mul(factor), baseDisplay.a);
    }

    const finalOutput = vignettedNode ?? lutGradedNode ?? displayNode;
    const pipeline = new RenderPipeline(renderer, finalOutput);
    pipeline.outputColorTransform = false;

    return {
      pipeline,
      settings: wanted,
      scenePass,
      prePass,
      gtao,
      traaNode,
      traaPreviousDepth,
      ssgiNode,
      ssrNode,
      bloomNode,
      dofNode,
      dofActiveUniform,
      focusDistanceUniform,
      bokehScaleUniform,
      aspectUniform,
      lutTexture,
      ownedRTTs,
      disposed: false,
      hasRendered: false,
    };
  }

  function disposeGraph(target: ChainGraph): void {
    if (target.disposed) return;
    target.disposed = true;
    target.pipeline.dispose();
    target.scenePass.dispose();
    target.prePass?.dispose();
    target.gtao?.dispose();
    target.traaNode?.dispose();
    // Standalone texture: no target disposal can reach it, and TRAANode.dispose omits it.
    target.traaPreviousDepth?.dispose();
    target.ssgiNode?.dispose();
    target.ssrNode?.dispose();
    target.bloomNode?.dispose();
    target.dofNode?.dispose();
    for (const intermediate of target.ownedRTTs) intermediate.dispose();
    target.ownedRTTs.clear();
    target.lutTexture?.dispose();
  }

  // Start a rebuilt graph at the carried governor level, rather than constructing/rendering a
  // one-frame full-quality graph before render() has a chance to apply that level.
  let graph = buildGraph(settingsForCurrentLevel());
  // Initial recovery eligibility is applied once fellBack exists. A carried qualification only
  // survives when the reconstructed chain is eligible right now.
  applyRecoveryEligible(options.recoveryEligible === true);
  let lastSizeKey = '';

  /**
   * Applies the one size value this composition owns directly. PassNode and the display nodes size
   * their own render targets in `updateBefore`, after their source pass has rendered at the new
   * canvas dimensions. Eagerly resizing those targets here races that order on WebGPU and can make
   * TRAA copy a newly-sized region from the previous-sized beauty texture.
   */
  function forwardSize(pixelWidth: number, pixelHeight: number): void {
    graph.aspectUniform.value = pixelHeight > 0 ? pixelWidth / pixelHeight : 1.0;
  }

  const born = renderer.getDrawingBufferSize(new Vector2());
  forwardSize(Math.floor(born.width), Math.floor(born.height));

  /**
   * What the chain is drawing, which is the graph's own settings and never the level's wish: a
   * runtime fallback, or a rebuild that render() has not reached yet, must not be reported as the
   * effects being on. The composition root publishes this, so a lie here reads as a chain that
   * believes AO is on over a picture that has none.
   */
  function effectiveSettings(): PostSettings {
    return graph.settings;
  }

  /**
   * Builds the level's graph when the governor has dropped SSGI, SSR, bloom or depth of field.
   * Zeroing intensities would not prevent render targets from evaluating every frame, so inactive
   * passes leave the graph entirely to reclaim GPU budget.
   */
  function applyGovernorLevel(): void {
    if (fellBack) {
      return;
    }
    const wanted = settingsForCurrentLevel();
    if (
      wanted.ssgi === graph.settings.ssgi &&
      wanted.ssr === graph.settings.ssr &&
      wanted.bloom === graph.settings.bloom &&
      wanted.dof === graph.settings.dof
    ) {
      return;
    }
    const superseded = graph;
    graph = buildGraph(wanted);
    const size = renderer.getDrawingBufferSize(new Vector2());
    forwardSize(Math.floor(size.width), Math.floor(size.height));
    try {
      disposeGraph(superseded);
    } catch (disposeError) {
      console.warn('[archviz] the superseded post chain did not dispose cleanly:', disposeError);
    }
  }

  /**
   * The features record handed out by the getter, rebuilt only when one of its inputs moves: the
   * graph (a governor rebuild, a fallback or a new chain), the SSGI scale, the depth-of-field gate
   * or the motion window. Between changes the same record is returned, so the composition root can
   * key its publication on the record identity and skip the string building entirely. The record is
   * chain-owned: readers must copy it, never mutate it.
   */
  let publishedFeatures: PostChain['features'] | null = null;
  let publishedFeaturesGraph: ChainGraph | null = null;
  let publishedFeaturesSSGIScale = 1.0;
  let publishedFeaturesDofAllowed = true;
  let publishedFeaturesMoving = false;

  function currentFeatures(): PostChain['features'] {
    const graphNow = graph;
    const ssgiScale = wantedSSGIScale();
    const dofAllowed = depthOfFieldAllowed;
    const moving = performance.now() - lastMotionTimestamp < MOTION_MS;
    if (
      publishedFeatures !== null &&
      publishedFeaturesGraph === graphNow &&
      publishedFeaturesSSGIScale === ssgiScale &&
      publishedFeaturesDofAllowed === dofAllowed &&
      publishedFeaturesMoving === moving
    ) {
      return publishedFeatures;
    }

    const effective = graphNow.settings;
    let ssgiFeature: 'off' | 'half' | 'full' = 'off';
    if (effective.ssgi !== 'off') {
      ssgiFeature = ssgiScale < 1 ? 'half' : 'full';
    }

    let dofFeature: 'off' | 'ready' | 'on' = 'off';
    if (effective.dof !== 'off' && graphNow.dofNode !== null) {
      if (!dofAllowed) {
        dofFeature = 'off';
      } else {
        dofFeature = moving ? 'ready' : 'on';
      }
    }

    publishedFeatures = {
      ao: effective.ao,
      traa: effective.traa,
      msaa: effective.msaa,
      ssgi: ssgiFeature,
      ssr: effective.ssr,
      bloom: effective.bloom,
      lut: effective.lut,
      vignette: effective.vignette,
      dof: dofFeature,
    };
    publishedFeaturesGraph = graphNow;
    publishedFeaturesSSGIScale = ssgiScale;
    publishedFeaturesDofAllowed = dofAllowed;
    publishedFeaturesMoving = moving;
    return publishedFeatures;
  }

  let motionTimer: number | null = null;

  /**
   * The one stable rest callback, created once per chain. Motion noticed after it was armed moves
   * the rest deadline forward, so a firing callback re-arms itself for the remainder instead of
   * every moving frame canceling and re-registering a timer. At the true deadline it asks for the
   * one redraw that switches depth of field from 'ready' to 'on', which render() applies.
   */
  function onMotionRest(): void {
    motionTimer = null;
    const remaining = MOTION_REST_DELAY_MS - (performance.now() - lastMotionTimestamp);
    if (remaining > 0 && graph.dofNode !== null) {
      motionTimer = window.setTimeout(onMotionRest, remaining);
      return;
    }
    if (graph.dofNode !== null && depthOfFieldAllowed) {
      requestFrame?.();
    }
  }

  /** The one gate behind the interface method and the test-only handle below. */
  function applyDepthOfFieldAllowed(allowed: boolean): void {
    if (depthOfFieldAllowed !== allowed) {
      depthOfFieldAllowed = allowed;
      // A change decided while the loop is idle needs a frame drawn for data-post to show it.
      requestFrame?.();
    }
  }

  return {
    render(): void {
      if (disposed) return;
      try {
        applyGovernorLevel();

        if (graph.ssgiNode !== null) {
          const scale = wantedSSGIScale();
          if (scale !== currentSSGIScale) {
            currentSSGIScale = scale;
            const size = renderer.getDrawingBufferSize(new Vector2());
            graph.ssgiNode.setSize(Math.floor(size.width), Math.floor(size.height));
          }
        }

        if (graph.dofNode !== null) {
          const isMoving = performance.now() - lastMotionTimestamp < MOTION_MS;
          const isDofOn = depthOfFieldAllowed && !isMoving;
          if (graph.dofActiveUniform !== null) {
            graph.dofActiveUniform.value = isDofOn ? 1.0 : 0.0;
          }
          if (graph.bokehScaleUniform !== null) {
            graph.bokehScaleUniform.value = isDofOn ? DOF_BOKEH_SCALE : 0.0;
          }
          if (graph.focusDistanceUniform !== null) {
            graph.focusDistanceUniform.value = focusDistance();
          }
        }

        graph.pipeline.render();
        graph.hasRendered = true;
      } catch (error) {
        if (fellBack) {
          throw error;
        }
        fellBack = true;
        // A fallback ends recovery: qualification accumulated on the enhanced path is void.
        applyRecoveryEligible(false);
        console.warn(
          `[archviz] post chain fell back to pass-through on ${backendName(renderer)}:`,
          error,
        );
        const broken = graph;
        graph = buildGraph(PASS_THROUGH);
        lastSizeKey = '';
        try {
          disposeGraph(broken);
        } catch (disposeError) {
          console.warn('[archviz] the failed post chain did not dispose cleanly:', disposeError);
        }
      }
    },

    get active(): boolean {
      const effective = effectiveSettings();
      return (
        effective.ao ||
        effective.traa ||
        effective.ssgi !== 'off' ||
        effective.ssr ||
        effective.bloom ||
        effective.lut ||
        effective.vignette ||
        effective.dof !== 'off'
      );
    },

    get features(): {
      ao: boolean;
      traa: boolean;
      msaa: boolean;
      ssgi: 'off' | 'half' | 'full';
      ssr: boolean;
      bloom: boolean;
      lut: boolean;
      vignette: boolean;
      dof: 'off' | 'ready' | 'on';
    } {
      return currentFeatures();
    },

    get governorState(): GovernorState | null {
      return governor?.state ?? null;
    },

    get governorDiagnostics(): GovernorDiagnostics | null {
      if (governor === null || fellBack) {
        return null;
      }
      // No explicit clock: the governor reports against its last observed sample, which is the
      // real performance.now() in production and the injected clock in the deterministic harness.
      const diagnostics = governor.diagnostics();
      return {
        ...diagnostics,
        // The proof bridge reports the chain's current combined gate, not the eligibility of a
        // sample observed before a tab hide/loading transition.
        recoveryEligible,
      };
    },

    get fellBack(): boolean {
      return fellBack;
    },

    setRecoveryEligible(eligible: boolean): void {
      applyRecoveryEligible(eligible);
    },

    get governorHarness(): GovernorTestHarness | null {
      if (governor === null || fellBack) {
        return null;
      }
      return {
        setDeterministic(on: boolean): void {
          const changed = deterministicSampling !== on;
          deterministicSampling = on;
          if (on || changed) {
            // The injected samples carry their own clock. Readings observed on the page's real
            // clock before this moment - and injected readings before returning to real frames -
            // must not leak into the other timeline. The stream-owned state resets while the
            // committed level, cooldown and history carry over.
            const active = governor;
            active?.resetSamplingState();
          }
        },
        observe(
          workMs: number,
          nowMs: number,
          eligible: boolean,
        ): GovernorDiagnostics | null {
          const active = governor;
          if (active === null || fellBack) {
            return null;
          }
          // The injected eligibility is explicit on purpose: the tests synthesise lifecycle
          // interruptions no real tab event can produce deterministically.
          const before = active.level;
          active.observe(workMs, nowMs, eligible);
          if (active.level !== before) {
            // The decided level is applied in render(); a frame must be drawn for it to commit.
            requestFrame?.();
          }
          return active.diagnostics(nowMs);
        },
      };
    },

    setDepthOfFieldAllowed(allowed: boolean): void {
      applyDepthOfFieldAllowed(allowed);
    },

    observeFrame(workMs: number): void {
      if (governor === null || fellBack) {
        return;
      }
      if (deterministicSampling) {
        // The e2e harness owns the stream while deterministic sampling is on; a real frame's
        // reading must not contaminate the injected sequence.
        return;
      }
      // onFrameTime fires only for frames the loop actually drew (loop.ts lines 62-68), so every
      // reading that reaches here is a drawn frame. The governor keeps receiving them at every
      // level, including below 'no-ssr': recovery has to be able to climb back from there,
      // and the ladder's own patience decides whether another step is ever taken.
      const before = governor.level;
      governor.observe(workMs, performance.now(), recoveryEligible);
      if (governor.level !== before) {
        // The new level is applied in render(), which an idle loop would not reach on its own.
        requestFrame?.();
      }
    },

    notifyMotion(): void {
      if (disposed) return;
      lastMotionTimestamp = performance.now();
      // The stable rest callback below holds the rest deadline once armed, so a moving frame
      // neither cancels nor registers a timer; a new one is needed only when none is pending and
      // a live depth-of-field graph exists that its rest redraw could serve.
      if (typeof window !== 'undefined' && motionTimer === null && graph.dofNode !== null) {
        motionTimer = window.setTimeout(onMotionRest, MOTION_REST_DELAY_MS);
      }
    },

    setSize(width: number, height: number): void {
      if (disposed) return;
      const ratio = renderer.getPixelRatio();
      const key = `${width}:${height}:${ratio}`;
      if (key === lastSizeKey) {
        return;
      }
      lastSizeKey = key;
      forwardSize(Math.floor(width * ratio), Math.floor(height * ratio));
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (motionTimer !== null && typeof window !== 'undefined') {
        window.clearTimeout(motionTimer);
        motionTimer = null;
      }
      disposeGraph(graph);
    },
  };
}
