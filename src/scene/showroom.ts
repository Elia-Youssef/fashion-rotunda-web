// The showroom scene. The rotunda and the plinth load once and stay; one
// look stands on the plinth and is replaced on request, with its GPU resources freed as it goes.
// A replacement cross-fades over CROSSFADE_MS instead of swapping in one frame.
//
// What this module owns: the three.js scene graph, the placement rule, the switch race, the
// cross-fade and the disposal. What it deliberately does not own: the DOM (main.ts writes the
// canvas attributes), the render loop (it only calls onChange so the caller can invalidate) and
// the lighting, which main.ts composes from src/lighting around this scene.

import {
  Box3,
  Color,
  Euler,
  Group,
  Material,
  Mesh,
  PerspectiveCamera,
  Quaternion,
  Scene,
} from 'three/webgpu';
import type { Object3D, WebGPURenderer } from 'three/webgpu';
import type { GLTF, GLTFLoader, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { hash, screenCoordinate, uniform } from 'three/tsl';

import { PROOF_VIEW, contentUrl } from '../catalog/catalog';
import type { Catalog, CatalogLook } from '../catalog/catalog';
import { createSwitcher } from '../catalog/switcher';
import { CROSSFADE_MS, createFadeMachine } from './crossfade';
import { createGltfLoader } from './loaders';
import { createLookOwner } from './look-owner';
import type { LookOwner } from './look-owner';
import { applyTunings } from './materials';
import { listVariants, selectVariant } from './variants';
import type { VariantTarget } from './variants';

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
  /** Downloads and parsing overlap; scene attachment waits for its startup prerequisites. */
  beforeMount?: (kind: 'statics' | 'look') => Promise<unknown>;
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
  /** Read-only scene-graph state used by the e2e regression for the turntable contract. */
  readonly turntableState: TurntableState;
}

/** The turntable's actual graph ownership and world-space yaw, without exposing mutable nodes. */
export interface TurntableState {
  yaw: number;
  plinthWorldYaw: number | null;
  activeLookWorldYaw: number | null;
  outgoingLookWorldYaw: number | null;
  plinthAttached: boolean;
  activeLookAttached: boolean;
  outgoingLookAttached: boolean;
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
 * type is MeshStandardMaterial from createDefaultMaterial, line 2321) and the renderer turns them
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

/** One look on the heap: what is on screen, and the owner that frees it when it is replaced. */
interface LoadedLook {
  id: string;
  root: Object3D;
  parser: GLTFParser;
  variants: string[];
  /** The variant actually applied, null when the file carries none. */
  applied: string | null;
  /** Everything the look owns and its retirement state; see look-owner.ts. */
  owner: LookOwner;
  /** Every mesh of the look, with the caster flag the decorator assigned it. */
  casters: Caster[];
  /** The look's own opacity uniform; while it fades, its value is written once per frame. */
  opacity: FadeUniform;
}

/** One parsed GLTF paired with the owner that releases it if it never reaches the scene. */
interface OwnedGltf {
  gltf: GLTF;
  owner: LookOwner;
}

/** The directory a file was fetched from, which is what GLTFLoader.parse resolves relative URIs against. */
function directoryOf(url: string): string {
  const cut = url.lastIndexOf('/');
  return cut === -1 ? '' : url.slice(0, cut + 1);
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

const loggedFiles = new Set<string>();

function logMaterialClasses(fileName: string, root: Object3D): void {
  if (loggedFiles.has(fileName)) {
    return;
  }
  loggedFiles.add(fileName);
  const rows: { material: string; type: string }[] = [];
  const seen = new Set<Material>();
  root.traverse((object: Object3D) => {
    if (object instanceof Mesh) {
      const assigned = object.material;
      const list = Array.isArray(assigned) ? assigned : [assigned];
      for (const mat of list) {
        if (!seen.has(mat)) {
          seen.add(mat);
          rows.push({ material: mat.name, type: mat.type });
        }
      }
    }
  });
  console.log(`[archviz] material classes for ${fileName}:`, rows);
}

function tuneHierarchy(root: Object3D, fileName?: string): void {
  applyTunings(root);
  if (import.meta.env.DEV && fileName !== undefined) {
    logMaterialClasses(fileName, root);
  }
}

export function createShowroom(options: ShowroomOptions): Showroom {
  const { renderer, catalog, contentBase, onChange } = options;
  const decorate = options.decorate ?? ((): void => undefined);

  const scene = new Scene();
  scene.background = new Color(SCENE_BACKGROUND);
  // The rotunda is deliberately not here: only the product turntable moves. The plinth and every
  // active fade participant share this one transform, so a look arriving mid-rotation cannot
  // start at a different yaw or receive the turn twice.
  const turntable = new Group();
  scene.add(turntable);

  const view = catalog.views[PROOF_VIEW];
  const camera = new PerspectiveCamera(view.fov, 1, CAMERA_NEAR, CAMERA_FAR);
  camera.position.set(view.position[0], view.position[1], view.position[2]);
  camera.lookAt(view.target[0], view.target[1], view.target[2]);

  // Started here, awaited at the first load: the WebAssembly decoder and the transcoder support
  // probe both cost time that overlaps the catalogue's own fetch.
  const loaderPromise = createGltfLoader(renderer, contentBase);

  /** The plinth's top in metres, so the look's feet stand on it. 0 until the plinth has loaded. */
  let plinthTopY = 0;
  let plinthRoot: Object3D | null = null;
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

  function worldYaw(root: Object3D | null): number | null {
    if (root === null) {
      return null;
    }
    const orientation = root.getWorldQuaternion(new Quaternion());
    return new Euler().setFromQuaternion(orientation, 'YXZ').y;
  }

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
    for (const material of look.owner.materials) {
      const fadeMaterial = material as FadeMaterial;
      if ((fadeMaterial.opacityNode ?? null) === opacityNode) {
        // Already carrying this look's uniform. A second stamp would move the material's version
        // for nothing, and a moved version with a changed cache key throws the render object away
        // and rebuilds it (RenderObjects.js lines 136-142).
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
    const owner = createLookOwner();
    const loaded: LoadedLook = {
      id,
      root: gltf.scene,
      parser: gltf.parser,
      variants: listVariants(gltf),
      applied: null,
      owner,
      casters: [],
      opacity: uniform(1),
    };
    try {
      tuneHierarchy(gltf.scene, look.file);
      const wanted = variantFor(look, loaded.variants);
      if (wanted !== null) {
        // Applied before the look reaches the scene, so a switch never shows one frame of the
        // previous swatch. A look still loading is not on screen for anything to replace, so
        // only its own release can stop the swap.
        await selectVariant(variantTarget(loaded, () => loaded.owner.retired), wanted);
        applyTunings(loaded.root);
        loaded.applied = wanted;
      }
      owner.collect(loaded.root);
      await options.beforeMount?.('look');
    } catch (error) {
      // The load is transactional: whatever was acquired along the way (parsed meshes, parked
      // originals, parser-resolved variant materials) is released rather than left ownerless.
      owner.collect(loaded.root);
      owner.retire();
      throw error;
    }
    return loaded;
  }

  /**
   * The variant helper's inputs, wired to the look's owner so every acquired material lands in
   * it. The stop signal is the caller's to define: a look stops receiving a swap once it no
   * longer counts, which for a swatch is the moment another look takes the screen.
   */
  function variantTarget(loaded: LoadedLook, superseded: () => boolean): VariantTarget {
    return {
      root: loaded.root,
      parser: loaded.parser,
      variants: loaded.variants,
      acquire: (material: Material): void => loaded.owner.register(material),
      superseded,
    };
  }

  /**
   * A parsed static and the owner of its resources. Statics are page-lifetime once mounted, but
   * the owner is what frees a parse that never gets there: its own load failing is nothing to
   * clean up, while the other static of the pair failing after this one parsed is.
   */
  async function loadOwned(url: string, signal: AbortSignal): Promise<OwnedGltf> {
    const gltf = await loadGltf(url, signal);
    const owner = createLookOwner();
    owner.collect(gltf.scene);
    return { gltf, owner };
  }

  function disposeLook(loaded: LoadedLook): void {
    loaded.root.removeFromParent();
    loaded.owner.retire();
  }

  const switcher = createSwitcher<LoadedLook>({
    load: loadLook,
    dispose: disposeLook,
    onReady: (_id: string, loaded: LoadedLook): void => {
      const previous = onScreen;
      onScreen = loaded;
      loaded.root.position.y = plinthTopY;
      decorate(loaded.root);
      // After the decorator, so the record holds the caster flags the lighting decided.
      captureCasters(loaded);
      turntable.add(loaded.root);
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
      const loads = [
        loadOwned(contentUrl(contentBase, catalog.rotunda.file), forever),
        loadOwned(contentUrl(contentBase, catalog.plinth.file), forever),
      ];
      try {
        const [rotunda, plinth] = await Promise.all(loads);
        await options.beforeMount?.('statics');
        tuneHierarchy(rotunda.gltf.scene, catalog.rotunda.file);
        tuneHierarchy(plinth.gltf.scene, catalog.plinth.file);
        // The level origin is the room centre at floor height and the plinth stands on it, so
        // both keep the transform they were exported with.
        decorate(rotunda.gltf.scene);
        decorate(plinth.gltf.scene);
        scene.add(rotunda.gltf.scene);
        turntable.add(plinth.gltf.scene);
        plinthRoot = plinth.gltf.scene;
        plinthTopY = new Box3().setFromObject(plinth.gltf.scene).max.y;
        if (onScreen !== null) {
          // A look that arrived before the plinth was measured is standing at floor height.
          onScreen.root.position.y = plinthTopY;
        }
        onChange();
      } catch (error) {
        // Whatever failed, nothing parsed stays on the heap: each load releases its own parse,
        // including a sibling that settles only after the pair has already failed. Tuning may
        // have replaced parsed materials with upgraded instances by then, so each root is
        // collected as it is now, keeping the upgrade owned with the parse it came from.
        for (const load of loads) {
          void load.then((owned: OwnedGltf) => {
            owned.owner.collect(owned.gltf.scene);
            owned.owner.retire();
          }, (): undefined => undefined);
        }
        throw error;
      }
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
      // A swatch belongs to the look that is on screen. onReady is the moment a switch takes
      // effect, so a look another one replaced is superseded for the whole outgoing fade, not
      // only once the fade releases it: no commit onto its meshes, no write to the variant
      // state the incoming look now owns.
      const superseded = (): boolean => look.owner.retired || look !== onScreen;
      await selectVariant(variantTarget(look, superseded), name);
      if (superseded()) {
        // The look stopped counting while the parser was resolving. What the swap acquired is
        // registered with the look's owner, which releases it when the look is released, and
        // the variant state on screen belongs to the look that replaced this one, so nothing
        // here may be written.
        return;
      }
      applyTunings(look.root);
      look.applied = name;
      currentVariant = name;
      wantedVariant = name;
      // A variant swap brings materials, and with them textures, that were not on the meshes when
      // the file was parsed. Without this the look would leak them when it is replaced.
      look.owner.collect(look.root);
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
      turntable.rotation.y = radians;
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

    get turntableState(): TurntableState {
      // The e2e reader runs between frames too, so update before reading world-space transforms.
      turntable.updateWorldMatrix(true, true);
      const outgoing = machine.outgoing;
      return {
        yaw: turntable.rotation.y,
        plinthWorldYaw: worldYaw(plinthRoot),
        activeLookWorldYaw: worldYaw(onScreen?.root ?? null),
        outgoingLookWorldYaw: worldYaw(outgoing?.root ?? null),
        plinthAttached: plinthRoot?.parent === turntable,
        activeLookAttached: onScreen?.root.parent === turntable,
        outgoingLookAttached: outgoing?.root.parent === turntable,
      };
    },
  };
}
