// Goals G2.3 and G2.5: ambient occlusion and anti-aliasing through the node post chain of three
// 0.186.0. The chain replaces renderer.render for every frame after the showroom exists: a pre-pass
// for normals and depth when the AO is on (the layout GTAONode's own JSDoc documents,
// examples/jsm/tsl/display/GTAONode.js lines 18-27), the scene pass that carries the beauty with
// the AO applied through the lighting context (GTAONode.js line 39) and, when TRAA is on, a
// velocity attachment (TRAANode.js lines 34-38 expect beauty, depth, velocity and camera), then
// either TRAA or MSAA on the scene pass, then the output quad.
//
// Source references below are to the installed three.js 0.186.0 under node_modules/three/ and are
// quoted with file and line.

import { RenderPipeline, Vector2 } from 'three/webgpu';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { builtinAOContext, mrt, normalView, output, pass, screenUV, velocity } from 'three/tsl';
import type GTAONode from 'three/addons/tsl/display/GTAONode.js';
import type TRAANode from 'three/addons/tsl/display/TRAANode.js';
import type { PerspectiveCamera, Scene } from 'three';
import type { PassNode, WebGPURenderer } from 'three/webgpu';

import { postSettingsFor } from './settings';
import type { PostSettings } from './settings';
import type { TierSettings } from '../tiers/table';

export interface PostChainOptions {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  tier: TierSettings;
  /** True on a touch device; the base tier's AO is desktop only. */
  isTouch: boolean;
}

export interface PostChain {
  /** Draws one frame through the chain; the loop's replacement for renderer.render. */
  render(): void;
  /** True when the chain does more than pass the beauty through (AO or TRAA active). */
  readonly active: boolean;
  /** What is on: for the proof overlay and the tests. */
  readonly features: { ao: boolean; traa: boolean; msaa: boolean };
  /** TRAA needs to know when the camera or the look moved, to reset its history and avoid ghosting. */
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
};

/** `?post=` forces a slice of the chain for development: off, ao or aa; anything else is the tier. */
function applyDevSwitch(tier: PostSettings): PostSettings {
  const wanted = new URLSearchParams(location.search).get('post');
  if (wanted === 'off') {
    return PASS_THROUGH;
  }
  if (wanted === 'ao') {
    return { ...tier, traa: false, msaa: false, samples: 0 };
  }
  if (wanted === 'aa') {
    return { ...tier, ao: false, aoHalfResolution: false };
  }
  return tier;
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
interface ChainGraph {
  pipeline: RenderPipeline;
  settings: PostSettings;
  scenePass: PassNode;
  prePass: PassNode | null;
  gtao: GTAONode | null;
  traaNode: TRAANode | null;
}

export function createPostChain(options: PostChainOptions): PostChain {
  const { renderer, scene, camera } = options;
  const settings = applyDevSwitch(postSettingsFor(options.tier, options.isTouch));

  function scenePassFor(wanted: PostSettings): PassNode {
    // An active chain always states its sample count. The pass inherits renderer.samples when its
    // options leave samples undefined (PassNode.js line 800), and this project's renderer is
    // created with antialias: true, which makes that 4 (Renderer.js line 275). TRAA must not
    // inherit it (TRAANode.js line 18: "MSAA must be disabled when TRAA is in use"), and the
    // development slices isolate one effect, so they state 0. Only the pass-through keeps the
    // default, which is the MSAA the plain renderer.render path drew with.
    if (wanted.ao || wanted.traa || wanted.msaa) {
      return pass(scene, camera, { samples: wanted.msaa ? 4 : 0 });
    }
    return pass(scene, camera);
  }

  function buildGraph(wanted: PostSettings): ChainGraph {
    const scenePass = scenePassFor(wanted);

    let prePass: PassNode | null = null;
    let gtao: GTAONode | null = null;
    if (wanted.ao) {
      // The AO layout the node documents (GTAONode.js lines 18-27): a pass whose MRT output is the
      // view-space normal, the depth from that pass's depth texture, then ao(depth, normal,
      // camera). The pre-pass states samples 0 for the same reason the scene pass does.
      prePass = pass(scene, camera, { samples: 0 });
      prePass.setMRT(mrt({ output: normalView }));
      gtao = ao(prePass.getTextureNode('depth'), prePass.getTextureNode(), camera);
      gtao.resolutionScale = wanted.aoHalfResolution ? 0.5 : 1;
      // The documented composite (GTAONode.js line 39): the AO multiplies the indirect light
      // inside the scene pass's own materials instead of the beauty after the fact, so direct
      // light and speculars keep their level. builtinAOContext skips transparent materials
      // (ContextNode.js line 258), which also keeps the glass dome from being darkened.
      scenePass.contextNode = builtinAOContext(gtao.getTextureNode().sample(screenUV).r);
    }

    let traaNode: TRAANode | null = null;
    if (wanted.traa) {
      // TRAA reprojects the history along per-pixel velocity (TRAANode.js lines 34-38 take beauty,
      // depth, velocity, camera). The velocity node computes the motion in the vertex stage from
      // the previous frame's matrices (VelocityNode.js lines 164-180); the MRT routes it to a
      // texture next to the beauty, which is the attachment TRAANode reads back.
      scenePass.setMRT(mrt({ output, velocity }));
      traaNode = traa(
        scenePass.getTextureNode(),
        scenePass.getTextureNode('depth'),
        scenePass.getTextureNode('velocity'),
        camera,
      );
    }

    // PostProcessing in 0.186.0 is the deprecated rename of this class (PostProcessing.js lines
    // 5-26; its constructor prints a warning, line 20), so the chain uses the class it wraps: the
    // same render() and the same outputNode contract.
    const pipeline = new RenderPipeline(renderer, traaNode ?? scenePass);
    // outputColorTransform stays at its default true: the pipeline wraps the output node in
    // renderOutput once (RenderPipeline.js lines 192-194) and holds the renderer at NoToneMapping
    // and the working colour space while its quad draws (RenderPipeline.js lines 138-156), so AgX
    // and the sRGB output are applied exactly once, at the end. Nothing upstream transforms
    // colour: the passes render linear HDR into half-float targets (PassNode.js lines 246 and
    // 802), which is why the chain applies no tone mapping of its own anywhere.

    return { pipeline, settings: wanted, scenePass, prePass, gtao, traaNode };
  }

  function disposeGraph(target: ChainGraph): void {
    target.pipeline.dispose();
    target.scenePass.dispose();
    target.prePass?.dispose();
    target.gtao?.dispose();
    target.traaNode?.dispose();
  }

  let graph = buildGraph(settings);
  let fellBack = false;
  let lastSizeKey = '';

  /** Forwards drawing-buffer pixels to everything allocated in the current graph. */
  function forwardSize(pixelWidth: number, pixelHeight: number): void {
    graph.scenePass.setSize(pixelWidth, pixelHeight);
    graph.prePass?.setSize(pixelWidth, pixelHeight);
    graph.gtao?.setSize(pixelWidth, pixelHeight);
    // TRAANode gets no forward: @types/three 0.186.0 declares no setSize on it, and it sizes its
    // history and resolve targets from the scene pass's render target on every frame anyway
    // (TRAANode.js lines 363-385), so following the beauty is its own documented behaviour.
  }

  // Size the targets from the drawing buffer once at creation. The passes are born 1x1 and resize
  // themselves on their first render (PassNode.js lines 835-839), but a first frame drawn against
  // a still-1x1 beauty is what TRAA replays until its history restarts: it re-seeds the history
  // from the beauty only on a size change (TRAANode.js lines 384-401), so a full-size beauty at
  // the first frame makes that frame a real picture instead of one stretched texel.
  const born = renderer.getDrawingBufferSize(new Vector2());
  forwardSize(Math.floor(born.width), Math.floor(born.height));

  return {
    render(): void {
      try {
        graph.pipeline.render();
      } catch (error) {
        // A node that cannot draw on this backend (a shader the transpiler rejects, an attachment
        // the context lacks) breaks the whole frame, and a dead picture helps nobody: the chain
        // drops to the plain beauty with one warning and keeps the page alive. A failure of the
        // pass-through itself is a page-level renderer failure and keeps throwing.
        if (fellBack) {
          throw error;
        }
        fellBack = true;
        console.warn(
          `[archviz] post chain fell back to pass-through on ${backendName(renderer)}:`,
          error,
        );
        // Build the replacement and swap it in before touching the old graph. Disposal walks
        // render targets and materials on a renderer that has just failed a frame, so it is the
        // most likely thing here to throw a second time; doing it last, and inside its own guard,
        // keeps that throw out of the frame loop and still leaves the page with a working graph.
        const broken = graph;
        graph = buildGraph(PASS_THROUGH);
        // The size guard remembers the size last forwarded to the graph that is now gone. The new
        // graph's targets have never been sized, so the memo has to go or the next setSize with
        // the same dimensions would return early and leave them unsized.
        lastSizeKey = '';
        try {
          disposeGraph(broken);
        } catch (disposeError) {
          console.warn('[archviz] the failed post chain did not dispose cleanly:', disposeError);
        }
      }
    },

    get active(): boolean {
      return graph.settings.ao || graph.settings.traa;
    },

    get features(): { ao: boolean; traa: boolean; msaa: boolean } {
      return {
        ao: graph.settings.ao,
        traa: graph.settings.traa,
        msaa: graph.settings.msaa,
      };
    },

    notifyMotion(): void {
      // TRAANode 0.186.0 has no documented history reset: its public surface is getTextureNode,
      // setSize, setViewOffset, clearViewOffset and dispose (TRAANode.js). History rejection is
      // built into the resolve instead: a depth difference above depthThreshold invalidates the
      // history sample (TRAANode.js lines 563-566), which is what camera motion causes, and the
      // velocity buffer carries the reprojection (VelocityNode.js). The residual ghosting risk is
      // a look switch with an unchanged silhouette, where depth stands still while the colour
      // changes; variance clipping bounds that (TRAANode.js lines 587-590). The method stays on
      // the interface so the wiring can call it and a three version with a real reset slots in
      // without a contract change.
    },

    setSize(width: number, height: number): void {
      // The pass and both nodes re-read the drawing buffer size on every render themselves
      // (PassNode.js lines 835-839, GTAONode.js lines 369-370, TRAANode.js lines 363-385), so
      // this only keeps them from lagging one render behind a pixel-ratio change. The guard keeps
      // the scaler's repeated calls cheap: nothing reallocates unless the size really moved, and
      // the nodes expect drawing-buffer pixels, which is CSS size times the pixel ratio.
      const ratio = renderer.getPixelRatio();
      const key = `${width}:${height}:${ratio}`;
      if (key === lastSizeKey) {
        return;
      }
      lastSizeKey = key;
      forwardSize(Math.floor(width * ratio), Math.floor(height * ratio));
    },

    dispose(): void {
      disposeGraph(graph);
    },
  };
}
