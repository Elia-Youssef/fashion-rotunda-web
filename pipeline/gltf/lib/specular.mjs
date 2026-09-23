// Rules for keeping authored KHR_materials_specular data through optimization.
//
// The extension defaults are specularFactor 1 and specularColorFactor [1, 1, 1]. Keeping an
// extension at those defaults provides no visual information, while stripping a non-default value
// changes the source material. This module is pure so the pipeline decision is independently tested.

export const DEFAULT_SPECULAR_FACTOR = 1;
export const DEFAULT_SPECULAR_COLOR = [1, 1, 1];

/** True when an authored specular extension carries information the optimizer must keep. */
export function shouldPreserveSpecular({
  factor = DEFAULT_SPECULAR_FACTOR,
  color = DEFAULT_SPECULAR_COLOR,
  hasSpecularTexture = false,
  hasSpecularColorTexture = false,
} = {}) {
  return (
    factor !== DEFAULT_SPECULAR_FACTOR ||
    color.length !== DEFAULT_SPECULAR_COLOR.length ||
    color.some((component, index) => component !== DEFAULT_SPECULAR_COLOR[index]) ||
    hasSpecularTexture ||
    hasSpecularColorTexture
  );
}
