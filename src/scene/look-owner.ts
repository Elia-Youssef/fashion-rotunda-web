// One look's resource registry and its retirement state.
//
// A look can outlive its screen time: a swatch click can still be awaiting the parser when a
// later look replaces this one. The caller defines that moment (supersession, decided at the
// switch itself) separately from this module's own retirement, which can come later, at fade
// end. Every asynchronous step registers what it acquires here before committing it anywhere,
// and stops once its look no longer counts. Retirement releases every registered resource, and
// a registration that arrives after retirement releases itself, so nothing acquired for a look
// is ever left without an owner: not by a replaced look, a rejected load or a failed variant.

import { Material, Mesh, Texture } from 'three/webgpu';
import type { BufferGeometry, Object3D } from 'three/webgpu';

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

/** A dispose listener can throw anything; the report is a list of Error objects. */
function asError(thrown: unknown): Error {
  if (thrown instanceof Error) {
    return thrown;
  }
  try {
    return new Error(String(thrown));
  } catch {
    // Some values cannot become a string (an object without a prototype, a throwing toString).
    // The report must not fail on them, or the releases after this one would be skipped.
    return new Error('a resource release threw a value that cannot be printed', { cause: thrown });
  }
}

export interface LookOwner {
  /** True once the look has been released for good; later work must not commit onto it. */
  readonly retired: boolean;
  /** The materials registered so far, live; the cross-fade stamps its dissolve onto each. */
  readonly materials: ReadonlySet<Material>;
  /** Registers every geometry and material reachable from the meshes of `root`. */
  collect(root: Object3D): void;
  /**
   * Registers one material acquired outside the parse, before it reaches a mesh, so an
   * interrupted or failed swap cannot lose it. After retirement the material has no owner
   * left, so it is released at once.
   */
  register(material: Material): void;
  /**
   * Releases everything registered and marks the look retired. Safe to call again. Every
   * resource is attempted independently, so one throwing disposer cannot skip the rest; the
   * registry is cleared whatever happens, and the collected errors are returned. Cleanup never
   * throws at the caller: retirement runs from the render loop's fade end and from detached
   * sibling cleanup, where a throw would break a frame or surface as an unhandled rejection,
   * so the errors are also reported here, once.
   */
  retire(): Error[];
}

export function createLookOwner(): LookOwner {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  // Retirement can race an in-flight registration that shares a material (the parser caches
  // per index) or a texture with something already released; these keep every release to
  // exactly one dispose attempt.
  const releasedGeometries = new WeakSet<BufferGeometry>();
  const releasedMaterials = new WeakSet<Material>();
  const releasedTextures = new WeakSet<Texture>();
  let retired = false;

  function releaseGeometry(geometry: BufferGeometry, errors: Error[]): void {
    if (releasedGeometries.has(geometry)) {
      return;
    }
    releasedGeometries.add(geometry);
    try {
      geometry.dispose();
    } catch (error) {
      errors.push(asError(error));
    }
  }

  function releaseTexture(texture: Texture, errors: Error[]): void {
    if (releasedTextures.has(texture)) {
      return;
    }
    releasedTextures.add(texture);
    try {
      texture.dispose();
    } catch (error) {
      errors.push(asError(error));
    }
  }

  function releaseMaterial(material: Material, errors: Error[]): void {
    if (releasedMaterials.has(material)) {
      return;
    }
    releasedMaterials.add(material);
    const textures = new Set<Texture>();
    collectTextures(material, textures);
    try {
      material.dispose();
    } catch (error) {
      errors.push(asError(error));
    }
    // The textures are the look's resources just as much as the material: they are attempted
    // even when the material's own disposal threw, or one failing listener would orphan them.
    for (const texture of textures) {
      releaseTexture(texture, errors);
    }
  }

  /** One report per failed release pass, at the source: most callers have no one to throw to. */
  function report(errors: Error[]): void {
    if (errors.length > 0) {
      console.warn('[archviz] look resource release failed', errors);
    }
  }

  return {
    get retired(): boolean {
      return retired;
    },
    get materials(): ReadonlySet<Material> {
      return materials;
    },
    collect(root: Object3D): void {
      const foundGeometries = new Set<BufferGeometry>();
      const foundMaterials = new Set<Material>();
      root.traverse((object: Object3D) => {
        if (!(object instanceof Mesh)) {
          return;
        }
        foundGeometries.add(object.geometry);
        const assigned = object.material;
        if (Array.isArray(assigned)) {
          for (const material of assigned) {
            foundMaterials.add(material);
          }
        } else {
          foundMaterials.add(assigned);
        }
        // The variant helper parks the primitive's first material here; it is still a GPU
        // resource even while a variant material is the one on screen.
        const original: unknown = object.userData['originalMaterial'];
        if (original instanceof Material) {
          foundMaterials.add(original);
        }
      });
      if (retired) {
        // Collected after retirement: nothing will own these, so they are released at once.
        const errors: Error[] = [];
        for (const geometry of foundGeometries) {
          releaseGeometry(geometry, errors);
        }
        for (const material of foundMaterials) {
          releaseMaterial(material, errors);
        }
        report(errors);
        return;
      }
      for (const geometry of foundGeometries) {
        geometries.add(geometry);
      }
      for (const material of foundMaterials) {
        materials.add(material);
      }
    },
    register(material: Material): void {
      if (retired) {
        const errors: Error[] = [];
        releaseMaterial(material, errors);
        report(errors);
        return;
      }
      materials.add(material);
    },
    retire(): Error[] {
      if (retired) {
        return [];
      }
      retired = true;
      const errors: Error[] = [];
      try {
        for (const geometry of geometries) {
          releaseGeometry(geometry, errors);
        }
        for (const material of materials) {
          releaseMaterial(material, errors);
        }
      } finally {
        geometries.clear();
        materials.clear();
      }
      report(errors);
      return errors;
    },
  };
}
