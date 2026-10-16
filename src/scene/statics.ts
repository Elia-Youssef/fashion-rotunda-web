// The room and plinth load, mount and release together if either static fails.

import { Box3 } from 'three/webgpu';
import type { Material, Object3D } from 'three/webgpu';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { contentUrl } from '../catalog/catalog';
import type { Catalog } from '../catalog/catalog';
import { createLookOwner } from './look-owner';
import type { LookOwner } from './look-owner';
import type { TuningAcquire } from './materials';

interface StaticsMount {
  plinthRoot: Object3D;
  plinthTopY: number;
}

interface StaticsOptions {
  loadGltf: (url: string, signal: AbortSignal) => Promise<GLTF>;
  catalog: Catalog;
  contentBase: string;
  decorate: (root: Object3D) => void;
  tune: (root: Object3D, acquire: TuningAcquire, fileName?: string) => void;
  beforeMount: ((kind: 'statics') => Promise<unknown>) | undefined;
  scene: Object3D;
  turntable: Object3D;
  /** Publishes placement and notifies the caller inside the same failure boundary as mounting. */
  mounted: (statics: StaticsMount) => void;
}

/** One parsed GLTF paired with the owner that releases it if it never reaches the scene. */
interface OwnedGltf {
  gltf: GLTF;
  owner: LookOwner;
}

/**
 * A parsed static and the owner of its resources. Statics are page-lifetime once mounted, but
 * the owner is what frees a parse that never gets there: its own load failing is nothing to
 * clean up, while the other static of the pair failing after this one parsed is.
 */
async function loadOwned(
  loadGltf: StaticsOptions['loadGltf'], url: string, signal: AbortSignal,
): Promise<OwnedGltf> {
  const gltf = await loadGltf(url, signal);
  const owner = createLookOwner();
  owner.collect(gltf.scene);
  return { gltf, owner };
}

export async function loadStatics(options: StaticsOptions): Promise<void> {
  const { loadGltf, catalog, contentBase, decorate, tune, beforeMount, scene, turntable, mounted } = options;
  // Neither static is ever replaced, so neither needs an abort route; the controller exists
  // only because loadGltf takes a signal.
  const forever = new AbortController().signal;
  const loads = [
    loadOwned(loadGltf, contentUrl(contentBase, catalog.rotunda.file), forever),
    loadOwned(loadGltf, contentUrl(contentBase, catalog.plinth.file), forever),
  ];
  try {
    const [rotunda, plinth] = await Promise.all(loads);
    await beforeMount?.('statics');
    tune(
      rotunda.gltf.scene,
      (material: Material) => rotunda.owner.register(material),
      catalog.rotunda.file,
    );
    tune(
      plinth.gltf.scene,
      (material: Material) => plinth.owner.register(material),
      catalog.plinth.file,
    );
    // The level origin is the room centre at floor height and the plinth stands on it, so
    // both keep the transform they were exported with.
    decorate(rotunda.gltf.scene);
    decorate(plinth.gltf.scene);
    scene.add(rotunda.gltf.scene);
    turntable.add(plinth.gltf.scene);
    const plinthRoot = plinth.gltf.scene;
    const plinthTopY = new Box3().setFromObject(plinth.gltf.scene).max.y;
    mounted({ plinthRoot, plinthTopY });
  } catch (error) {
    // Whatever failed, nothing parsed stays on the heap: each load releases its own parse,
    // including a sibling that settles only after the pair has already failed. Tuning may
    // have replaced parsed materials with upgraded instances by then, so each root is
    // collected as it is now, keeping the upgrade owned with the parse it came from.
    for (const load of loads) {
      // A sibling's own rejection is dropped: the primary error rethrows below and is what the visitor sees.
      void load.then((owned: OwnedGltf) => {
        owned.owner.collect(owned.gltf.scene);
        owned.owner.retire();
      }, (): undefined => undefined);
    }
    throw error;
  }
}
