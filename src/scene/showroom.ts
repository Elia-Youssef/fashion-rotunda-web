// The showroom scene. The rotunda and the plinth load once and stay; one
// look stands on the plinth and is replaced on request, with its GPU resources freed as it goes.
// A replacement cross-fades over CROSSFADE_MS instead of swapping in one frame.
//
// What this module owns: the three.js scene graph, the placement rule, the switch race, the
// cross-fade and the disposal. What it deliberately does not own: the DOM (main.ts writes the
// canvas attributes), the render loop (it only calls onChange so the caller can invalidate) and
// the lighting, which main.ts composes from src/lighting around this scene.

import {
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
import { uniform } from 'three/tsl';

import { PROOF_VIEW, contentUrl } from '../catalog/catalog';
import type { Catalog, CatalogLook } from '../catalog/catalog';
import { createSwitcher } from '../catalog/switcher';
import { createFadeMachine } from './crossfade';
import {
  captureCasters, fadeDurationMs, setCasting, setDissolve, SWITCH_MEASURE, SWITCH_START_MARK,
} from './dissolve';
import type { Caster, FadeUniform } from './dissolve';
import { createGltfLoader } from './loaders';
import { createLookOwner } from './look-owner';
import type { LookOwner } from './look-owner';
import { applyTunings } from './materials';
import type { TuningAcquire } from './materials';
import { loadStatics } from './statics';
import { listVariants, selectVariant } from './variants';
import type { VariantTarget } from './variants';

/** The clear colour behind the room, dark enough that an unlit frame reads as empty, not broken. */
export const SCENE_BACKGROUND = 0x15181c;

/** The room is about 16 m across and 8 m tall, so these bounds hold it with room to spare. */
const CAMERA_NEAR = 0.05;
const CAMERA_FAR = 120;

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

/** The directory a file was fetched from, which is what GLTFLoader.parse resolves relative URIs against. */
function directoryOf(url: string): string {
  const cut = url.lastIndexOf('/');
  return cut === -1 ? '' : url.slice(0, cut + 1);
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

function tuneHierarchy(root: Object3D, acquire: TuningAcquire, fileName?: string): void {
  applyTunings(root, acquire);
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

  const machine = createFadeMachine<LoadedLook>({
    dissolve: (look: LoadedLook, on: boolean): void => {
      setDissolve({ materials: look.owner.materials, opacity: look.opacity, casters: look.casters }, on);
    },
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
   * FileLoader owns an AbortController (node_modules/three/src/loaders/FileLoader.js line 66)
   * and combines its signal with the manager's when AbortSignal.any is available (line 133).
   * FileLoader.abort() aborts only its controller (lines 355-358); LoadingManager owns and aborts
   * a separate controller (node_modules/three/src/loaders/LoadingManager.js lines 292-320).
   * GLTFLoader implements no abort() of its own; aborting the manager can also cancel the rotunda
   * and other requests using that manager's signal. Fetching and then calling
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
      // Every upgrade the tuning makes from here on is the look's from the moment its
      // materials change hands, including a displaced original no later collect can reach.
      const acquire = (material: Material): void => owner.register(material);
      tuneHierarchy(gltf.scene, acquire, look.file);
      const wanted = variantFor(look, loaded.variants);
      if (wanted !== null) {
        // Applied before the look reaches the scene, so a switch never shows one frame of the
        // previous swatch. A look still loading is not on screen for anything to replace, so
        // only its own release can stop the swap.
        await selectVariant(variantTarget(loaded, () => loaded.owner.retired), wanted);
        applyTunings(loaded.root, acquire);
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

    loadStatics(): Promise<void> {
      return loadStatics({
        loadGltf, catalog, contentBase, decorate, tune: tuneHierarchy,
        beforeMount: options.beforeMount, scene, turntable,
        mounted: (statics): void => {
          plinthRoot = statics.plinthRoot;
          plinthTopY = statics.plinthTopY;
          if (onScreen !== null) {
            // A look that arrived before the plinth was measured is standing at floor height.
            onScreen.root.position.y = plinthTopY;
          }
          onChange();
        },
      });
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
      // The retune after the swap displaces the material the parser resolved onto the mesh;
      // both sides of each upgrade stay with the look that asked for the variant.
      applyTunings(look.root, (material: Material) => look.owner.register(material));
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
