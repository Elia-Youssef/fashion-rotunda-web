// Goal G1.7, G5.1 step 4: the showroom scene. The rotunda and the plinth load once and stay; one
// look stands on the plinth and is replaced on request, with its GPU resources freed as it goes.
// A replacement since G5.1 cross-fades over CROSSFADE_MS instead of swapping in one frame.
//
// What this module owns: the three.js scene graph, the placement rule, the switch race, the
// cross-fade and the disposal. What it deliberately does not own: the DOM (main.ts writes the
// canvas attributes), the render loop (it only calls onChange so the caller can invalidate) and
// the lighting, which main.ts composes from src/lighting around this scene.

import {
  Box3,
  Color,
  Material,
  Mesh,
  PerspectiveCamera,
  Scene,
  Texture,
} from 'three/webgpu';
import type { BufferGeometry, Object3D, WebGPURenderer } from 'three/webgpu';
import type { GLTF, GLTFLoader, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { hash, screenCoordinate, uniform } from 'three/tsl';

import { PROOF_VIEW, contentUrl } from '../catalog/catalog';
import type { Catalog, CatalogLook } from '../catalog/catalog';
import { createSwitcher } from '../catalog/switcher';
import { CROSSFADE_MS, createFadeMachine } from './crossfade';
import { createGltfLoader } from './loaders';
import { listVariants, selectVariant } from './variants';

/** The clear colour behind the room, dark enough that an unlit frame reads as empty, not broken. */
export const SCENE_BACKGROUND = 0x15181c;

/** The room is about 16 m across and 8 m tall, so these bounds hold it with room to spare. */
const CAMERA_NEAR = 0.05;
const CAMERA_FAR = 120;

/**
 * Turns a fragment's screen coordinate into one integer seed, so the hash below is a function of
 * the pixel and of nothing else. A row stride wider than any drawing buffer this page asks for
 * keeps two pixels of the same frame off the same seed.
 */
const HASH_ROW_STRIDE = 8192;

/**
 * The dissolve's per-pixel threshold: one node, built once, shared by every material of the look
 * that is fading out. hash() is the PCG hash of three/tsl (src/nodes/math/Hash.js lines 11-21),
 * in [0, 1), and screenCoordinate is the fragment's window-relative position in pixels on both
 * backends (src/nodes/display/ScreenNode.js lines 149-171 flips the WebGL 2 frag coord to the
 * WebGPU convention). Screen space, not local position, is what makes the decision shared: the
 * garment and the mannequin under it read the same threshold at the same pixel and are therefore
 * kept or discarded together.
 */
const DISSOLVE_THRESHOLD = hash(screenCoordinate.y.mul(HASH_ROW_STRIDE).add(screenCoordinate.x));

/** User Timing names, read by the proof panel; other modules' wiring depends on them. */
const SWITCH_START_MARK = 'look-switch-start';
const SWITCH_MEASURE = 'look-switch';

export interface ShowroomOptions {
  renderer: WebGPURenderer;
  catalog: Catalog;
  contentBase: string;
  /** Called whenever something on screen changed, so the caller can ask the loop for a frame. */
  onChange: () => void;
  /** Called on every loaded root before it enters the scene; the lighting uses it to enable shadows. */
  decorate?: (root: Object3D) => void;
}

export interface Showroom {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  loadStatics(): Promise<void>;
  showLook(id: string): Promise<void>;
  setVariant(name: string): Promise<void>;
  setAspect(aspect: number): void;
  /** Turns the look on the plinth about its vertical axis; the turntable and the Rotate action use it. */
  setLookYaw(radians: number): void;
  /** Advances a running fade by the frame's dt; the loop's render callback calls it every frame. */
  update(dtMs: number): void;
  /** True while a fade runs. */
  readonly fading: boolean;
  /** Resolves when no fade runs (at once when none does); the e2e switch handle awaits it. */
  settle(): Promise<void>;
  /** Milliseconds from the last showLook call to its first faded frame; null before the first switch. */
  readonly lastSwitchMs: number | null;
  readonly lookYaw: number;
  readonly currentLook: string | null;
  readonly currentVariant: string | null;
}

/**
 * The node three/tsl's uniform() returns, narrowed to what the fade does with it: one number
 * written per frame. The name is not exported from 'three/tsl', and the structural view keeps
 * this module free of renderer internals.
 */
interface FadeUniform {
  value: number;
}

/** The threshold node's type, taken from the function that builds it rather than re-declared. */
type DissolveThreshold = typeof DISSOLVE_THRESHOLD;

/**
 * GLTFLoader builds classic materials (loadMaterial, GLTFLoader.js lines 3596-3736; the default
 * type is MeshStandardMaterial from createDefaultMaterial, line 2317) and the renderer turns them
 * into node materials per build by copying every own property onto the node class for the type
 * (NodeLibrary.js lines 52-70, reached from NodeBuilder.prebuild, NodeBuilder.js line 3156). The
 * fade writes opacityNode on the classic instance and lets that copy carry it into the shader.
 * Material's type carries neither node slot, so the one assertion below widens to this structural
 * type.
 */
type FadeMaterial = Material & {
  opacityNode: FadeUniform | null;
  alphaTestNode: DissolveThreshold | null;
};

/**
 * One mesh of a look with the castShadow the decorator gave it. The sun's shadow pass draws every
 * caster through one shared override material, so the dissolve cannot reach it and the only
 * honest control is whether the mesh is in the pass at all; this is what "on" restores to.
 */
interface Caster {
  mesh: Mesh;
  assigned: boolean;
}

/** One look on the heap: what is on screen, and everything that has to be freed to replace it. */
interface LoadedLook {
  id: string;
  root: Object3D;
  parser: GLTFParser;
  variants: string[];
  /** The variant actually applied, null when the file carries none. */
  applied: string | null;
  geometries: Set<BufferGeometry>;
  materials: Set<Material>;
  /** Every mesh of the look, with the caster flag the decorator assigned it. */
  casters: Caster[];
  /** The look's own opacity uniform; while it fades, its value is written once per frame. */
  opacity: FadeUniform;
}

/** The directory a file was fetched from, which is what GLTFLoader.parse resolves relative URIs against. */
function directoryOf(url: string): string {
  const cut = url.lastIndexOf('/');
  return cut === -1 ? '' : url.slice(0, cut + 1);
}

/**
 * Adds every geometry and material reachable from the look to its disposal sets. Called again
 * after a variant change, because a variant swap puts materials on the meshes that were not there
 * when the file was parsed, and the set is what dispose() walks.
 */
function collectResources(loaded: LoadedLook): void {
  loaded.root.traverse((object: Object3D) => {
    if (!(object instanceof Mesh)) {
      return;
    }
    loaded.geometries.add(object.geometry);
    const assigned = object.material;
    if (Array.isArray(assigned)) {
      for (const material of assigned) {
        loaded.materials.add(material);
      }
    } else {
      loaded.materials.add(assigned);
    }
    // The variant helper parks the primitive's first material here; it is still a GPU resource
    // even while a variant material is the one on screen.
    const original: unknown = object.userData['originalMaterial'];
    if (original instanceof Material) {
      loaded.materials.add(original);
    }
  });
}

/**
 * Records every mesh of the look with the caster flag it is holding right now. Called once, after
 * the decorator has run and before the fade can touch anything, so "restore" means the value the
 * lighting decided from the material, not the false every GLB mesh arrives with.
 */
function captureCasters(loaded: LoadedLook): void {
  loaded.casters.length = 0;
  loaded.root.traverse((object: Object3D) => {
    if (object instanceof Mesh) {
      loaded.casters.push({ mesh: object, assigned: object.castShadow });
    }
  });
}

/**
 * Textures are reached through the material's own properties. Naming the map fields one by one
 * (map, normalMap, roughnessMap, clearcoatNormalMap and the dozen others) is how a texture gets
 * missed when a material class gains a slot, so every own property is inspected instead.
 */
function collectTextures(material: Material, into: Set<Texture>): void {
  const values: unknown[] = Object.values(material);
  for (const value of values) {
    if (value instanceof Texture) {
      into.add(value);
    }
  }
}

export function createShowroom(options: ShowroomOptions): Showroom {
  const { renderer, catalog, contentBase, onChange } = options;
  const decorate = options.decorate ?? ((): void => undefined);

  const scene = new Scene();
  scene.background = new Color(SCENE_BACKGROUND);

  const view = catalog.views[PROOF_VIEW];
  const camera = new PerspectiveCamera(view.fov, 1, CAMERA_NEAR, CAMERA_FAR);
  camera.position.set(view.position[0], view.position[1], view.position[2]);
  camera.lookAt(view.target[0], view.target[1], view.target[2]);

  // Started here, awaited at the first load: the WebAssembly decoder and the transcoder support
  // probe both cost time that overlaps the catalogue's own fetch.
  const loaderPromise = createGltfLoader(renderer, contentBase);

  /** The plinth's top in metres, so the look's feet stand on it. 0 until the plinth has loaded. */
  let plinthTopY = 0;
  let onScreen: LoadedLook | null = null;
  let currentVariant: string | null = null;
  /** The swatch the visitor chose, carried to every later look that offers it. */
  let wantedVariant: string | null = null;
  /** The turn of the look on the plinth, kept across switches so a rotating look stays rotated. */
  let lookYaw = 0;
  /** Pending settle() calls, resolved when a fade ends and no new one replaced it. */
  let fadeWaiters: (() => void)[] = [];
  /** The latest 'look-switch' measure's duration; null until a fade has drawn its first frame. */
  let lastSwitchMs: number | null = null;

  /**
   * Turns the dissolve on or off for every material the look holds. On, the look keeps
   * transparent false and depthWrite true and gets two node slots: opacityNode multiplies the
   * look's uniform into the fragment alpha (NodeMaterial.js lines 865-866) and alphaTestNode
   * discards the fragment when that alpha falls to the threshold (lines 872-887, the discard at
   * 883). Both slots are the same for every surface of the look, and the threshold is a function
   * of the screen pixel alone, so one pixel is one decision for the whole look: it keeps the
   * garment and the mannequin under it together, or drops both and shows the incoming look, which
   * is opaque behind it. A surviving pixel is written with alpha 1 in the opaque pass
   * (lines 899-903, builder.isOpaque at NodeBuilder.js lines 527-531), so the two looks write
   * depth and never sort against each other.
   *
   * Off, both slots go back to null, which is what keeps a material the variant swap parked from
   * carrying the dissolve into a later look that reuses it.
   */
  function setDissolve(look: LoadedLook, on: boolean): void {
    const opacityNode = on ? look.opacity : null;
    const alphaTestNode = on ? DISSOLVE_THRESHOLD : null;
    for (const material of look.materials) {
      const fadeMaterial = material as FadeMaterial;
      if ((fadeMaterial.opacityNode ?? null) === opacityNode) {
        // Already carrying this look's uniform. A second stamp would move the material's version
        // for nothing, and a moved version with a changed cache key throws the render object away
        // and rebuilds it (RenderObjects.js lines 135-141).
        continue;
      }
      fadeMaterial.opacityNode = opacityNode;
      fadeMaterial.alphaTestNode = alphaTestNode;
      // Both fields change the shader, not a uniform value, so the shader has to be rebuilt once
      // at each end of the fade and never between.
      material.needsUpdate = true;
    }
  }

  /**
   * Whether the look is in the sun's shadow pass. Off parks every mesh, on gives back what the
   * decorator assigned; the fade holds exactly one of the two looks on at any frame.
   */
  function setCasting(look: LoadedLook, on: boolean): void {
    for (const caster of look.casters) {
      caster.mesh.castShadow = on && caster.assigned;
    }
  }

  const machine = createFadeMachine<LoadedLook>({
    dissolve: setDissolve,
    opacity: (look: LoadedLook, value: number): void => {
      look.opacity.value = value;
    },
    casting: setCasting,
    dispose: (look: LoadedLook): void => {
      disposeLook(look);
    },
    firstFrame: (): void => {
      lastSwitchMs = performance.measure(SWITCH_MEASURE, SWITCH_START_MARK).duration;
    },
    settled: resolveFadeWaiters,
  });

  /**
   * Reduced motion gets the old instant swap: a duration of 0 completes the fade on its first
   * frame, which leaves the same pixels on screen as the pre-fade swap did.
   */
  function fadeDurationMs(): number {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : CROSSFADE_MS;
  }

  /**
   * Hands the pending settle() calls back. The recheck runs in a microtask so a switch that
   * interrupts one fade with another (the machine ends the old fade and starts the new one in one
   * synchronous run) keeps the waiters pending until the second fade has ended too.
   */
  function resolveFadeWaiters(): void {
    if (fadeWaiters.length === 0) {
      return;
    }
    const waiting = fadeWaiters;
    fadeWaiters = [];
    queueMicrotask(() => {
      if (machine.running) {
        fadeWaiters = [...waiting, ...fadeWaiters];
      } else {
        for (const resolve of waiting) {
          resolve();
        }
      }
    });
  }

  function lookById(id: string): CatalogLook {
    const look = catalog.looks.find((candidate) => candidate.id === id);
    if (look === undefined) {
      throw new Error(`no look with the id "${id}" in the catalogue`);
    }
    return look;
  }

  /**
   * Fetches the bytes here rather than through GLTFLoader.load, because the loader's own
   * FileLoader shares one AbortController with its LoadingManager (FileLoader.js line 133,
   * LoadingManager.js lines 292-320) and GLTFLoader implements no abort() of its own, so
   * cancelling one look that way would cancel the rotunda with it. Fetching and then calling
   * parseAsync keeps the signal per request; the parse that follows an abort is skipped because
   * fetch rejects first.
   */
  async function loadGltf(url: string, signal: AbortSignal): Promise<GLTF> {
    const loader: GLTFLoader = await loaderPromise;
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`content: ${url} answered ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    return loader.parseAsync(bytes, directoryOf(url));
  }

  /** The variant to show on a look: the visitor's choice when this look has it, else its default. */
  function variantFor(look: CatalogLook, available: string[]): string | null {
    if (wantedVariant !== null && available.includes(wantedVariant)) {
      return wantedVariant;
    }
    if (available.includes(look.defaultVariant)) {
      return look.defaultVariant;
    }
    return null;
  }

  async function loadLook(id: string, signal: AbortSignal): Promise<LoadedLook> {
    const look = lookById(id);
    const gltf = await loadGltf(contentUrl(contentBase, look.file), signal);
    const variants = listVariants(gltf);
    const loaded: LoadedLook = {
      id,
      root: gltf.scene,
      parser: gltf.parser,
      variants,
      applied: null,
      geometries: new Set<BufferGeometry>(),
      materials: new Set<Material>(),
      casters: [],
      opacity: uniform(1),
    };
    const wanted = variantFor(look, variants);
    if (wanted !== null) {
      // Applied before the look reaches the scene, so a switch never shows one frame of the
      // previous swatch.
      await selectVariant({ root: loaded.root, parser: loaded.parser, variants }, wanted);
      loaded.applied = wanted;
    }
    collectResources(loaded);
    return loaded;
  }

  function disposeLook(loaded: LoadedLook): void {
    loaded.root.removeFromParent();
    for (const geometry of loaded.geometries) {
      geometry.dispose();
    }
    const textures = new Set<Texture>();
    for (const material of loaded.materials) {
      collectTextures(material, textures);
      material.dispose();
    }
    for (const texture of textures) {
      texture.dispose();
    }
    loaded.geometries.clear();
    loaded.materials.clear();
  }

  const switcher = createSwitcher<LoadedLook>({
    load: loadLook,
    dispose: disposeLook,
    onReady: (_id: string, loaded: LoadedLook): void => {
      const previous = onScreen;
      onScreen = loaded;
      loaded.root.position.y = plinthTopY;
      loaded.root.rotation.y = lookYaw;
      decorate(loaded.root);
      // After the decorator, so the record holds the caster flags the lighting decided.
      captureCasters(loaded);
      scene.add(loaded.root);
      currentVariant = loaded.applied;
      if (previous === null) {
        // The first look has nothing to fade against; it stands on the plinth as loaded.
        loaded.opacity.value = 1;
      } else {
        // A switch that lands mid-fade is the machine's own interrupt: the running fade ends
        // first, so rapid clicks never stack a third look on the plinth.
        machine.start(previous, loaded, fadeDurationMs());
      }
      onChange();
    },
  });

  return {
    scene,
    camera,

    async loadStatics(): Promise<void> {
      // Neither static is ever replaced, so neither needs an abort route; the controller exists
      // only because loadGltf takes a signal.
      const forever = new AbortController().signal;
      const [rotunda, plinth] = await Promise.all([
        loadGltf(contentUrl(contentBase, catalog.rotunda.file), forever),
        loadGltf(contentUrl(contentBase, catalog.plinth.file), forever),
      ]);
      // The level origin is the room centre at floor height and the plinth stands on it, so both
      // keep the transform they were exported with.
      decorate(rotunda.scene);
      decorate(plinth.scene);
      scene.add(rotunda.scene);
      scene.add(plinth.scene);
      plinthTopY = new Box3().setFromObject(plinth.scene).max.y;
      if (onScreen !== null) {
        // A look that arrived before the plinth was measured is standing at floor height.
        onScreen.root.position.y = plinthTopY;
      }
      onChange();
    },

    async showLook(id: string): Promise<void> {
      lookById(id);
      if (id !== switcher.current && id !== switcher.pending) {
        // The proof contract: the panel reads the latest 'look-switch' measure, and this mark is
        // its start. Neither a click for the look already on screen nor a second click on the look
        // already coming is a switch: the second would move the mark forward under a measure that
        // the first click's fade will close, and print a switch far shorter than the visitor saw.
        performance.mark(SWITCH_START_MARK);
      }
      await switcher.request(id);
    },

    async setVariant(name: string): Promise<void> {
      const look = onScreen;
      if (look === null) {
        throw new Error(`setVariant("${name}") needs a look on screen`);
      }
      if (!look.variants.includes(name)) {
        throw new Error(`the look "${look.id}" has no variant "${name}"`);
      }
      await selectVariant({ root: look.root, parser: look.parser, variants: look.variants }, name);
      look.applied = name;
      currentVariant = name;
      wantedVariant = name;
      // A variant swap brings materials, and with them textures, that were not on the meshes when
      // the file was parsed. Without this the look would leak them when it is replaced.
      collectResources(look);
      // No dissolve to re-stamp: only the outgoing look carries one, and the look a swatch lands
      // on is the incoming one, which is opaque for the whole fade. setDissolve skips a material
      // already carrying the look's uniform, so a re-stamp would cost nothing either way.
      onChange();
    },

    setAspect(aspect: number): void {
      if (!Number.isFinite(aspect) || aspect <= 0) {
        return;
      }
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },

    setLookYaw(radians: number): void {
      lookYaw = radians;
      if (onScreen === null) {
        return;
      }
      onScreen.root.rotation.y = radians;
      const outgoing = machine.outgoing;
      if (outgoing !== null) {
        // Both looks turn while the fade runs, so the dissolve does not swing.
        outgoing.root.rotation.y = radians;
      }
      onChange();
    },

    update(dtMs: number): void {
      if (!machine.running) {
        return;
      }
      machine.advance(dtMs);
      // While the fade runs this is what keeps the on-demand loop drawing: an invalidate called
      // from inside the render callback schedules the next frame (loop.ts re-checks the flag
      // after render returns), so the fade never stalls on a page that renders on demand. The
      // frame that ends the fade owes one more call, which is why this is outside the guard above.
      onChange();
    },

    get fading(): boolean {
      return machine.running;
    },

    settle(): Promise<void> {
      if (!machine.running) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        fadeWaiters.push(resolve);
      });
    },

    get lastSwitchMs(): number | null {
      return lastSwitchMs;
    },

    get lookYaw(): number {
      return lookYaw;
    },

    get currentLook(): string | null {
      return onScreen === null ? null : onScreen.id;
    },

    get currentVariant(): string | null {
      return currentVariant;
    },
  };
}
