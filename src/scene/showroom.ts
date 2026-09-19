// Goal G1.7: the showroom scene. The rotunda and the plinth load once and stay; one look stands on
// the plinth and is replaced on request, with its GPU resources freed as it goes.
//
// What this module owns: the three.js scene graph, the placement rule, the switch race and the
// disposal. What it deliberately does not own: the DOM (main.ts writes the canvas attributes), the
// render loop (it only calls onChange so the caller can invalidate) and the lighting, which main.ts
// composes from src/lighting around this scene.

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

import { PROOF_VIEW, contentUrl } from '../catalog/catalog';
import type { Catalog, CatalogLook } from '../catalog/catalog';
import { createSwitcher } from '../catalog/switcher';
import { createGltfLoader } from './loaders';
import { listVariants, selectVariant } from './variants';

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
  readonly lookYaw: number;
  readonly currentLook: string | null;
  readonly currentVariant: string | null;
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
      if (onScreen !== null) {
        disposeLook(onScreen);
      }
      onScreen = loaded;
      loaded.root.position.y = plinthTopY;
      loaded.root.rotation.y = lookYaw;
      decorate(loaded.root);
      scene.add(loaded.root);
      currentVariant = loaded.applied;
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
      if (onScreen !== null) {
        onScreen.root.rotation.y = radians;
        onChange();
      }
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
