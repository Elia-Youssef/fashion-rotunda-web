// Material tuning table and application for dome glass and showroom surfaces.
//
// GLTFLoader maps extensions to material classes: standard materials are upgraded to physical
// materials when physical properties (transmission, clearcoat, anisotropy, sheen) are assigned.
// Source-backed values and appearance approximations share this table; the latter still require
// material-family visual review against Unreal references before acceptance.

import { Mesh, MeshPhysicalMaterial, MeshStandardMaterial } from 'three/webgpu';
import type { Material, Node, Object3D } from 'three/webgpu';
import { luminance, materialColor, mix, vec4 } from 'three/tsl';

export const DOME_GLASS_MATERIAL = 'M_Glass_Flat_SM_Dome_A';

// Owner's 2026-10-14 choice: the half-clearcoat option raised measured floor RMS contrast
// about 45 / 32 percent. Keep the separate Nero Vert inlay choice at 0.3.
const MARBLE_CLEARCOAT = 0.5;

// Exported base colour mean HSV saturation is 0.58791; mean linear luminance is 0.01073.
// At unit exposure a matching blue swatch gains 0.11818 saturation under ACES versus AgX.
// Mix 20 percent toward luminance, flatten contrast 10 percent about middle grey, then lift
// reflectance 10 percent: the owner chose this of five reviewed variants on 2026-10-14.
const BLUE_SILK_BASE_SATURATION = 0.8;
const BLUE_SILK_BASE_BRIGHTNESS = 1.1;
const BLUE_SILK_BASE_CONTRAST = 0.9;
// Contrast pivots around middle grey in the linear working colour space.
const BASE_CONTRAST_PIVOT = 0.18;

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
  /** Linear base colour: 1 leaves saturation, brightness or contrast unchanged. */
  baseSaturation?: number;
  baseBrightness?: number;
  baseContrast?: number;
}

/** Pure tuning dictionary indexed by material name as exported in glTF. */
const TUNING_TABLE: Readonly<Record<string, MaterialTuning>> = {
  M_BlueSilk: {
    baseSaturation: BLUE_SILK_BASE_SATURATION,
    baseBrightness: BLUE_SILK_BASE_BRIGHTNESS,
    baseContrast: BLUE_SILK_BASE_CONTRAST,
  },
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
    clearcoat: MARBLE_CLEARCOAT,
    clearcoatRoughness: 0.1,
  },
  MI_Marble_Nero_Vert: {
    // Owner's 2026-10-14 C3 choice: reducing the reflected sky darkened measured inlay lines
    // 22 to 29 percent while the light marble field changed at most 0.1 percent.
    clearcoat: 0.3,
    clearcoatRoughness: 0.1,
  },
  // Stills show polished blue fusion floor accents; KHR_materials_clearcoat
  MI_Quartzite_BlueFusion: {
    clearcoat: MARBLE_CLEARCOAT,
    clearcoatRoughness: 0.1,
  },
  // Stills show polished silver wave marble floor accents; KHR_materials_clearcoat
  MI_Marble_SilverWave: {
    clearcoat: MARBLE_CLEARCOAT,
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

/** The tuning for one material by its glTF name, or null when the material ships as exported. */
export function tuningFor(materialName: string): MaterialTuning | null {
  const tuning = TUNING_TABLE[materialName];
  return tuning ?? null;
}

/** Every name the table knows, for the test that pins them to the shipped files. */
export function tunedMaterialNames(): readonly string[] {
  return Object.keys(TUNING_TABLE);
}

/**
 * Receives every material a tuning upgrade displaces or creates, in the same synchronous step
 * as the upgrade itself. Handing both sides over before the upgrade can throw is what keeps a
 * failed or interrupted traversal from losing either of them; what ownership means is the
 * caller's to define, and the tuning layer guarantees only the timing.
 */
export type TuningAcquire = (material: Material) => void;

/**
 * Applies name-based tuning to every single-material mesh in a loaded hierarchy.
 *
 * GLTFLoader's variants helper replaces `mesh.material` after a look has parsed. Call this after
 * every variant selection as well as after the initial load, so a future tuned variant material is
 * upgraded before it is decorated, faded, or collected for disposal. Every material an upgrade
 * displaces or creates is handed to `acquire` before that upgrade can throw, so a caller that
 * owns the hierarchy's resources keeps every handoff, however the traversal ends.
 */
export function applyTunings(root: Object3D, acquire?: TuningAcquire): void {
  root.traverse((object: Object3D) => {
    if (!(object instanceof Mesh)) return;
    const assigned = object.material;
    const materials = Array.isArray(assigned) ? assigned : [assigned];
    for (const material of materials) {
      const tuning = tuningFor(material.name);
      if (tuning !== null) {
        applyTuning(object, tuning, acquire);
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
 * switcher hands the object over). `acquire` receives the displaced material and the new instance
 * of a physical upgrade before the copy and the assignment can throw, so a failed upgrade leaves
 * neither side unowned. Returns the material now on the mesh.
 */
export function applyTuning(mesh: Mesh, tuning: MaterialTuning, acquire?: TuningAcquire): Material {
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
    // Both sides of the handoff are owned before any step can throw: the displaced material,
    // which no mesh-collecting pass can reach once the assignment below has run, and the new
    // instance, which a throwing copy would otherwise orphan between construction and
    // assignment. Handover is not release: another mesh or the parser may still share the
    // displaced material, so its one release stays with the owner's retirement.
    acquire?.(material);
    acquire?.(upgraded);
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

  if (
    tuning.baseSaturation !== undefined ||
    tuning.baseBrightness !== undefined ||
    tuning.baseContrast !== undefined
  ) {
    // materialColor resolves the current map (including glTF UV transforms) times its factor.
    // Rebuild from that source on each variant application so repeated tuning never compounds.
    // The declaration says vec3; MaterialNode.COLOR actually returns RGBA for a mapped material.
    // Convert to vec4 so an unmapped factor gains alpha 1 and a mapped factor keeps texture alpha.
    const base = vec4(materialColor as unknown as Node<'vec4'>);
    let rgb = base.rgb;
    if (tuning.baseSaturation !== undefined) {
      rgb = mix(luminance(rgb), rgb, tuning.baseSaturation);
    }
    if (tuning.baseContrast !== undefined) {
      rgb = rgb.sub(BASE_CONTRAST_PIVOT).mul(tuning.baseContrast).add(BASE_CONTRAST_PIVOT);
    }
    if (tuning.baseBrightness !== undefined) {
      rgb = rgb.mul(tuning.baseBrightness);
    }
    // Keep texture alpha separate from RGB and leave opacity/alpha-test nodes to the fade.
    material.colorNode = vec4(rgb.max(0), base.a);
  }

  material.needsUpdate = true;
  return material;
}
