// Material tuning table and application for goals G2.6 and G2.7.
//
// GLTFLoader maps extensions to material classes: standard materials are upgraded to physical
// materials when physical properties (transmission, clearcoat, anisotropy, sheen) are assigned.
// Source-backed values and appearance approximations share this table; the latter still require
// material-family visual review against Unreal references before G2.7 closes.

import { Mesh, MeshPhysicalMaterial, MeshStandardMaterial } from 'three/webgpu';
import type { Material, Object3D } from 'three/webgpu';

export const DOME_GLASS_MATERIAL = 'M_Glass_Flat_SM_Dome_A';

/**
 * The selected default: physical transmission is enabled for the dome on every tier.
 * Base p95 measurements remain pending, so this is not a claim that every tier is inside budget.
 *
 * This is deliberately not named for Base. Tuning has no tier input, so a false value would be a
 * global fallback, not a Base-only policy. A future constrained-device policy must make that
 * decision before calling this module and pass it explicitly.
 */
export const DOME_TRANSMISSION_ENABLED = true;

export interface MaterialTuning {
  transmission?: number;
  thickness?: number;
  ior?: number;
  metalness?: number;
  roughness?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  anisotropy?: number;
  anisotropyRotation?: number;
  sheen?: number;
  sheenRoughness?: number;
  sheenColor?: [number, number, number];
  envMapIntensity?: number;
}

/** Pure tuning dictionary indexed by material name as exported in glTF. */
const TUNING_TABLE: Readonly<Record<string, MaterialTuning>> = {
  // The exported glass has metalness=1, which reflects the HDR's field/trees across the dome.
  // Transmission needs dielectric metalness=0 so the visible sky can actually show through.
  [DOME_GLASS_MATERIAL]: {
    transmission: 1.0,
    thickness: 0.02,
    ior: 1.0,
    metalness: 0,
    roughness: 0.05,
  },
  // Unreal Nero Base and Vert use clearcoat; restore its scalar lobe when the half GLB strips it.
  MI_Marble_Nero_Base: {
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
  },
  MI_Marble_Nero_Vert: {
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
  },
  // Stills show polished blue fusion floor accents; KHR_materials_clearcoat
  MI_Quartzite_BlueFusion: {
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
  },
  // Stills show polished silver wave marble floor accents; KHR_materials_clearcoat
  MI_Marble_SilverWave: {
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
  },
  // Stills show brushed brass inlays with directional specular reflection; KHR_materials_anisotropy
  MI_Metal_Brass_02: {
    anisotropy: 0.85,
    anisotropyRotation: 0,
  },
  // Stills show periwinkle woven fabric with edge sheen; KHR_materials_sheen
  MI_WallisDressA: {
    sheen: 1.0,
    sheenRoughness: 0.6,
    sheenColor: [0.27, 0.37, 0.63],
  },
  // Stills show periwinkle woven fabric trim with edge sheen; KHR_materials_sheen
  MI_WallisDressB: {
    sheen: 1.0,
    sheenRoughness: 0.6,
    sheenColor: [0.27, 0.37, 0.63],
  },
  // Stills show woven cotton dress with soft edge sheen; KHR_materials_sheen
  MI_NewLook_Dress: {
    sheen: 1.0,
    sheenRoughness: 0.6,
    sheenColor: [0.8, 0.8, 0.8],
  },
};

/** Global blend fallback for hardware that cannot afford the dome transmission target. */
const DOME_GLASS_BASE_FALLBACK: MaterialTuning = {
  roughness: 0.05,
  envMapIntensity: 2.0,
};

/** The tuning for one material by its glTF name, or null when the material ships as exported. */
export function tuningFor(materialName: string): MaterialTuning | null {
  if (materialName === DOME_GLASS_MATERIAL && !DOME_TRANSMISSION_ENABLED) {
    return DOME_GLASS_BASE_FALLBACK;
  }
  const tuning = TUNING_TABLE[materialName];
  return tuning ?? null;
}

/** Every name the table knows, for the test that pins them to the shipped files. */
export function tunedMaterialNames(): readonly string[] {
  return Object.keys(TUNING_TABLE);
}

/**
 * Applies name-based tuning to every single-material mesh in a loaded hierarchy.
 *
 * GLTFLoader's variants helper replaces `mesh.material` after a look has parsed. Call this after
 * every variant selection as well as after the initial load, so a future tuned variant material is
 * upgraded before it is decorated, faded, or collected for disposal.
 */
export function applyTunings(root: Object3D): void {
  root.traverse((object: Object3D) => {
    if (!(object instanceof Mesh)) return;
    const assigned = object.material;
    const materials = Array.isArray(assigned) ? assigned : [assigned];
    for (const material of materials) {
      const tuning = tuningFor(material.name);
      if (tuning !== null) {
        applyTuning(object, tuning);
      }
    }
  });
}

function needsPhysicalMaterial(tuning: MaterialTuning): boolean {
  return (
    tuning.transmission !== undefined ||
    tuning.thickness !== undefined ||
    tuning.ior !== undefined ||
    tuning.clearcoat !== undefined ||
    tuning.clearcoatRoughness !== undefined ||
    tuning.anisotropy !== undefined ||
    tuning.anisotropyRotation !== undefined ||
    tuning.sheen !== undefined ||
    tuning.sheenRoughness !== undefined ||
    tuning.sheenColor !== undefined
  );
}

function isStandardMaterial(material: Material): material is MeshStandardMaterial {
  return material instanceof MeshStandardMaterial;
}

function isPhysicalMaterial(material: MeshStandardMaterial): material is MeshPhysicalMaterial {
  return material instanceof MeshPhysicalMaterial;
}

/**
 * Applies a tuning to a loaded material in place. Never replaces the material instance: the
 * cross-fade patches opacityNode and alphaTestNode on the very instance the mesh holds, and the
 * variants extension caches instances by name. When a MeshStandardNodeMaterial needs a physical
 * property, the caller passes the mesh so the applier can swap the instance BEFORE the fade and the
 * variants see it (statics: in loadStatics before decorate; looks: in the loader's onLoad before the
 * switcher hands the object over). Returns the material now on the mesh.
 */
export function applyTuning(mesh: Mesh, tuning: MaterialTuning): Material {
  if (Array.isArray(mesh.material)) {
    throw new TypeError(
      `material tuning needs one material per mesh, but "${mesh.name}" has ${mesh.material.length}`,
    );
  }

  const assigned = mesh.material;
  if (!isStandardMaterial(assigned)) {
    throw new TypeError(
      `material tuning needs MeshStandardMaterial, but "${assigned.name}" is ${assigned.type}`,
    );
  }
  let material = assigned;

  let physical: MeshPhysicalMaterial | null =
    isPhysicalMaterial(material) ? material : null;

  if (needsPhysicalMaterial(tuning) && physical === null) {
    const upgraded = new MeshPhysicalMaterial();
    MeshStandardMaterial.prototype.copy.call(upgraded, material);
    mesh.material = upgraded;
    material = upgraded;
    physical = upgraded;
  }

  function requirePhysical(property: string): MeshPhysicalMaterial {
    if (physical === null) {
      throw new TypeError(`material "${material.name}" needs physical ${property}`);
    }
    return physical;
  }

  if (tuning.transmission !== undefined) {
    const tuned = requirePhysical('transmission');
    tuned.transmission = tuning.transmission;
    if (tuning.transmission > 0) {
      tuned.transparent = false;
      tuned.depthWrite = true;
      tuned.opacity = 1.0;
    }
  }

  if (tuning.thickness !== undefined) {
    requirePhysical('thickness').thickness = tuning.thickness;
  }

  if (tuning.ior !== undefined) {
    requirePhysical('ior').ior = tuning.ior;
  }

  if (tuning.roughness !== undefined) {
    material.roughness = tuning.roughness;
  }

  if (tuning.metalness !== undefined) {
    material.metalness = tuning.metalness;
  }

  if (tuning.clearcoat !== undefined) {
    requirePhysical('clearcoat').clearcoat = tuning.clearcoat;
  }

  if (tuning.clearcoatRoughness !== undefined) {
    requirePhysical('clearcoat roughness').clearcoatRoughness = tuning.clearcoatRoughness;
  }

  if (tuning.anisotropy !== undefined) {
    requirePhysical('anisotropy').anisotropy = tuning.anisotropy;
  }

  if (tuning.anisotropyRotation !== undefined) {
    requirePhysical('anisotropy rotation').anisotropyRotation = tuning.anisotropyRotation;
  }

  if (tuning.sheen !== undefined) {
    requirePhysical('sheen').sheen = tuning.sheen;
  }

  if (tuning.sheenRoughness !== undefined) {
    requirePhysical('sheen roughness').sheenRoughness = tuning.sheenRoughness;
  }

  if (tuning.sheenColor !== undefined) {
    requirePhysical('sheen color').sheenColor.setRGB(
      tuning.sheenColor[0],
      tuning.sheenColor[1],
      tuning.sheenColor[2],
    );
  }

  if (tuning.envMapIntensity !== undefined) {
    material.envMapIntensity = tuning.envMapIntensity;
  }

  material.needsUpdate = true;
  return material;
}
