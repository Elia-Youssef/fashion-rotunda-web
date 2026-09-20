// Goals G2.3, G2.5, G3.1, G3.2 and G3.5: ambient occlusion, anti-aliasing, screen-space global
// illumination and screen-space reflections through the node post chain of three 0.186.0, governed
// by frame work time.
//
// The chain replaces renderer.render for every frame after the showroom exists:
// 1. A pre-pass for normals, depth, metalness and roughness.
// 2. GTAO at half resolution composited through the lighting context (builtinAOContext).
// 3. The scene pass that carries beauty and, when TRAA is on, a velocity attachment.
// 4. SSGI computing diffuse bounce illumination from the scene pass beauty, normal and depth.
// 5. SSR computing specular screen-space reflections from beauty, normal, depth, metalness, roughness.
// 6. Composite of beauty + GI + SSR fed to TRAA (reprojected along velocity) or MSAA.
// 7. Output quad applying AgX tone mapping and sRGB color space conversion exactly once.
//
// The chain owns no DOM: what it turned on is read back through `features`, and the composition
// root is the one place that writes it onto the canvas.
//
// Source references below are to three.js 0.186.0 under node_modules/three/ and are quoted with
// file and line.

import { RenderPipeline, Vector2 } from 'three/webgpu';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import {
  builtinAOContext,
  materialMetalness,
  materialRoughness,
  mrt,
  normalView,
  output,
  pass,
  screenUV,
  vec4,
  velocity,
} from 'three/tsl';
import type GTAONode from 'three/addons/tsl/display/GTAONode.js';
import type TRAANode from 'three/addons/tsl/display/TRAANode.js';
import type SSGINode from 'three/addons/tsl/display/SSGINode.js';
import type SSRNode from 'three/addons/tsl/display/SSRNode.js';
import type { SSRNodeOptions } from 'three/addons/tsl/display/SSRNode.js';
import type { PerspectiveCamera, Scene } from 'three';
import type { Node, PassNode, WebGPURenderer } from 'three/webgpu';

import { postSettingsFor } from './settings';
import type { Backend, PostSettings } from './settings';
import type { TierSettings } from '../tiers/table';
import { createGovernor } from './governor';
import type { EnhancedLevel, Governor } from './governor';

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
}

export interface PostChain {
  /** Draws one frame through the chain; the loop's replacement for renderer.render. */
  render(): void;
  /** True when the chain does more than pass the beauty through. */
  readonly active: boolean;
  /** What is on: ao, traa, msaa, plus ssgi ('off' | 'half' | 'full') and ssr. */
  readonly features: {
    ao: boolean;
    traa: boolean;
    msaa: boolean;
    ssgi: 'off' | 'half' | 'full';
    ssr: boolean;
  };
  /** Feeds the loop's frame work time to the governor; the composition root calls it from onFrameTime. */
  observeFrame(workMs: number): void;
  /** TRAA and SSGI need to know when the camera or look moved, to reset history or switch resolution. */
  notifyMotion(): void;
  /** Call on every canvas size or pixel ratio change. */
  setSize(width: number, height: number): void;
  dispose(): void;
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
};

/** How long after the last motion notification the camera still counts as moving. */
const MOTION_MS = 500;

/**
 * `?post=` forces a slice of the chain for development: off, ao, aa, gi, ssr or max.
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
        ssgi: backend === 'webgpu' ? tier.ssgi : 'off',
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
  if (wanted === 'max') {
    return {
      settings: {
        ...tier,
        ssgi: backend === 'webgpu' ? tier.ssgi : 'off',
        ssr: backend === 'webgpu' && tier.ssr,
      },
      governorEnabled: false,
    };
  }
  const governorEnabled = backend === 'webgpu' && (tier.ssgi !== 'off' || tier.ssr);
  return { settings: tier, governorEnabled };
}

/** The backend label for the fallback warning, read the way create.ts reads it. */
function backendName(renderer: WebGPURenderer): string {
  const backend: object = renderer.backend;
  return 'isWebGPUBackend' in backend && backend.isWebGPUBackend === true ? 'webgpu' : 'webgl2';
}

/**
 * The graph behind one settings choice: null fields are features that are off, so dispose walks
 * exactly what was allocated.
 */
/** SSGINode in three.js 0.186.0 defines setSize at SSGINode.js line 343, but @types/three omits it. */
interface SSGINodeWithSize extends SSGINode {
  setSize(width: number, height: number): void;
}

interface ChainGraph {
  pipeline: RenderPipeline;
  settings: PostSettings;
  scenePass: PassNode;
  prePass: PassNode | null;
  gtao: GTAONode | null;
  traaNode: TRAANode | null;
  ssgiNode: SSGINodeWithSize | null;
  ssrNode: SSRNode | null;
}

export function createPostChain(options: PostChainOptions): PostChain {
  const { renderer, scene, camera, backend } = options;
  const requestFrame = options.requestFrame;
  const dev = applyDevSwitch(postSettingsFor(options.tier, options.isTouch, backend), backend);
  const settings = dev.settings;

  let governor: Governor | null = null;
  if (dev.governorEnabled) {
    governor = createGovernor({
      budgetMs: options.tier.frameBudgetMs,
      windowFrames: 60,
      patience: 2,
    });
  }

  let lastMotionTimestamp = 0;
  let currentSSGIScale = 1.0;

  function currentLevel(): EnhancedLevel {
    return governor?.level ?? 'full';
  }

  /**
   * The resolution scale the SSGI target is asked for: full only at the top of the ladder with
   * the camera at rest, half everywhere else. Once the governor has stepped past 'ssgi-half' the
   * node is out of the graph entirely, so this answers for the frames in which it still exists.
   */
  function wantedSSGIScale(): number {
    const isMoving = performance.now() - lastMotionTimestamp < MOTION_MS;
    return currentLevel() === 'full' && !isMoving ? 1.0 : 0.5;
  }

  function scenePassFor(wanted: PostSettings): PassNode {
    if (wanted.ao || wanted.traa || wanted.msaa || wanted.ssgi !== 'off' || wanted.ssr) {
      return pass(scene, camera, { samples: wanted.msaa ? 4 : 0 });
    }
    return pass(scene, camera);
  }

  function buildGraph(wanted: PostSettings): ChainGraph {
    const scenePass = scenePassFor(wanted);

    let prePass: PassNode | null = null;
    let gtao: GTAONode | null = null;
    let ssgiNode: SSGINodeWithSize | null = null;
    let ssrNode: SSRNode | null = null;

    const needsPrePass = wanted.ao || wanted.ssgi !== 'off' || wanted.ssr;
    if (needsPrePass) {
      prePass = pass(scene, camera, { samples: 0 });
      if (wanted.ssr) {
        // SSR requires metalness and roughness attachments to determine reflection specular lobes
        // and dielectric vs metal response. Extending the pre-pass MRT avoids a third geometry pass.
        prePass.setMRT(
          mrt({
            output: normalView,
            metalness: materialMetalness,
            roughness: materialRoughness,
          }),
        );
      } else {
        prePass.setMRT(mrt({ output: normalView }));
      }

      if (wanted.ao) {
        gtao = ao(prePass.getTextureNode('depth'), prePass.getTextureNode(), camera);
        gtao.resolutionScale = wanted.aoHalfResolution ? 0.5 : 1;
        scenePass.contextNode = builtinAOContext(gtao.getTextureNode().sample(screenUV).r);
      }
    }

    if (wanted.traa) {
      scenePass.setMRT(mrt({ output, velocity }));
    }

    if (wanted.ssgi !== 'off' && prePass !== null) {
      // SSGINode computes horizon-based diffuse bounce illumination from beauty, depth and normal.
      const rawSSGI = ssgi(
        scenePass.getTextureNode(),
        prePass.getTextureNode('depth'),
        prePass.getTextureNode(),
        camera,
      ) as SSGINodeWithSize;
      // SSGINode.updateBefore (SSGINode.js line 357) calls this.setSize with the full drawing
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
      // SSRNode.d.ts line 62 types normalNode as Node<'vec3'>, but runtime SSRNode.js line 1142
      // invokes normalNode.sample(uvS). A swizzled node (.rgb) lacks .sample(), so the underlying
      // PassTextureNode must be passed, which is what the type assertion below allows.
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

    // The composite exists only when SSGI or SSR has something to add. Null everywhere else, so a
    // graph without them is the node sequence this chain had before SSGI and SSR: the pass itself
    // reaches the pipeline, and nothing materialises its texture node before PassNode.setup does
    // (PassNode.js line 810). The AO-only and AA-only graphs are that path.
    let compositeColor: Node<'vec4'> | null = null;
    if (ssgiNode !== null && ssrNode !== null) {
      const beautyColor = scenePass.getTextureNode();
      compositeColor = vec4(
        beautyColor.rgb.add(ssgiNode.getGINode()).add(ssrNode.getTextureNode().rgb),
        beautyColor.a,
      );
    } else if (ssgiNode !== null) {
      const beautyColor = scenePass.getTextureNode();
      compositeColor = vec4(beautyColor.rgb.add(ssgiNode.getGINode()), beautyColor.a);
    } else if (ssrNode !== null) {
      const beautyColor = scenePass.getTextureNode();
      compositeColor = vec4(beautyColor.rgb.add(ssrNode.getTextureNode().rgb), beautyColor.a);
    }

    let traaNode: TRAANode | null = null;
    if (wanted.traa) {
      // TRAA reprojects the composite history along velocity vectors, providing temporal stability
      // and denoising for both SSGI and SSR.
      traaNode = traa(
        compositeColor ?? scenePass.getTextureNode(),
        scenePass.getTextureNode('depth'),
        scenePass.getTextureNode('velocity'),
        camera,
      );
    }

    const outputNode = traaNode ?? compositeColor ?? scenePass;
    const pipeline = new RenderPipeline(renderer, outputNode);

    return { pipeline, settings: wanted, scenePass, prePass, gtao, traaNode, ssgiNode, ssrNode };
  }

  function disposeGraph(target: ChainGraph): void {
    target.pipeline.dispose();
    target.scenePass.dispose();
    target.prePass?.dispose();
    target.gtao?.dispose();
    target.traaNode?.dispose();
    target.ssgiNode?.dispose();
    target.ssrNode?.dispose();
  }

  let graph = buildGraph(settings);
  let fellBack = false;
  let lastSizeKey = '';

  /** Forwards drawing-buffer pixels to everything allocated in the current graph. */
  function forwardSize(pixelWidth: number, pixelHeight: number): void {
    graph.scenePass.setSize(pixelWidth, pixelHeight);
    graph.prePass?.setSize(pixelWidth, pixelHeight);
    graph.gtao?.setSize(pixelWidth, pixelHeight);
    graph.ssgiNode?.setSize(pixelWidth, pixelHeight);
    graph.ssrNode?.setSize(pixelWidth, pixelHeight);
  }

  const born = renderer.getDrawingBufferSize(new Vector2());
  forwardSize(Math.floor(born.width), Math.floor(born.height));

  /** What each governor level asks for, off the settings the tier and `?post=` settled on. */
  function settingsForLevel(level: EnhancedLevel): PostSettings {
    if (level === 'full' || level === 'ssgi-half') {
      return settings;
    }
    if (level === 'no-ssgi') {
      return { ...settings, ssgi: 'off' };
    }
    // 'no-ssr' and 'base' both land on the chain without the enhanced passes: AO and TRAA only.
    return { ...settings, ssgi: 'off', ssr: false };
  }

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
   * Builds the level's graph when the governor has dropped SSGI or SSR. Zeroing giIntensity and
   * intensity would not do: SSGINode.updateBefore (SSGINode.js line 357) and SSRNode.updateBefore
   * (SSRNode.js line 742) render their targets every frame whatever the uniforms say, so a step
   * down that only zeroes them recovers no GPU time at all. The node has to leave the graph.
   */
  function applyGovernorLevel(): void {
    if (fellBack) {
      return;
    }
    const wanted = settingsForLevel(currentLevel());
    if (wanted.ssgi === graph.settings.ssgi && wanted.ssr === graph.settings.ssr) {
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

  function currentFeatures(): PostChain['features'] {
    const effective = effectiveSettings();
    let ssgiFeature: 'off' | 'half' | 'full' = 'off';
    if (effective.ssgi !== 'off') {
      ssgiFeature = wantedSSGIScale() < 1 ? 'half' : 'full';
    }
    return {
      ao: effective.ao,
      traa: effective.traa,
      msaa: effective.msaa,
      ssgi: ssgiFeature,
      ssr: effective.ssr,
    };
  }

  let motionTimer: number | null = null;

  return {
    render(): void {
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

        graph.pipeline.render();
      } catch (error) {
        if (fellBack) {
          throw error;
        }
        fellBack = true;
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
      return effective.ao || effective.traa || effective.ssgi !== 'off' || effective.ssr;
    },

    get features(): {
      ao: boolean;
      traa: boolean;
      msaa: boolean;
      ssgi: 'off' | 'half' | 'full';
      ssr: boolean;
    } {
      return currentFeatures();
    },

    observeFrame(workMs: number): void {
      if (governor === null || fellBack) {
        return;
      }
      // onFrameTime fires only for frames the loop actually drew (loop.ts lines 62-68), so every
      // reading that reaches here is a drawn frame. The full-resolution frames are the ones at
      // rest, and a motion gate would have hidden exactly those from the governor.
      if (graph.settings.ssgi === 'off' && !graph.settings.ssr) {
        return;
      }
      const before = governor.level;
      if (governor.observe(workMs) !== before) {
        // The new level is applied in render(), which an idle loop would not reach on its own.
        requestFrame?.();
      }
    },

    notifyMotion(): void {
      lastMotionTimestamp = performance.now();
      if (typeof window !== 'undefined') {
        if (motionTimer !== null) {
          window.clearTimeout(motionTimer);
        }
        motionTimer = window.setTimeout(() => {
          motionTimer = null;
          // Rest puts the SSGI target back to full resolution, which only happens inside render().
          // Without this the loop idles and no full-resolution frame is ever drawn.
          if (graph.ssgiNode !== null && wantedSSGIScale() !== currentSSGIScale) {
            requestFrame?.();
          }
        }, MOTION_MS + 10);
      }
    },

    setSize(width: number, height: number): void {
      const ratio = renderer.getPixelRatio();
      const key = `${width}:${height}:${ratio}`;
      if (key === lastSizeKey) {
        return;
      }
      lastSizeKey = key;
      forwardSize(Math.floor(width * ratio), Math.floor(height * ratio));
    },

    dispose(): void {
      if (motionTimer !== null && typeof window !== 'undefined') {
        window.clearTimeout(motionTimer);
        motionTimer = null;
      }
      disposeGraph(graph);
    },
  };
}
