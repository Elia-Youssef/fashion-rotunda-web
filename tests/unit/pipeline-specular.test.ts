import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SPECULAR_COLOR,
  DEFAULT_SPECULAR_FACTOR,
  shouldPreserveSpecular,
} from '../../pipeline/gltf/lib/specular.mjs';

describe('KHR_materials_specular optimizer policy', () => {
  it('strips the exact glTF defaults', () => {
    expect(shouldPreserveSpecular({
      factor: DEFAULT_SPECULAR_FACTOR,
      color: DEFAULT_SPECULAR_COLOR,
    })).toBe(false);
  });

  it.each([0.2, 0.25, 0.4, 0.55, 0.6])('preserves the authored non-default factor %s', (factor) => {
    expect(shouldPreserveSpecular({ factor })).toBe(true);
  });

  it('preserves authored colour and texture inputs even with the default scalar', () => {
    expect(shouldPreserveSpecular({ color: [0.8, 1, 1] })).toBe(true);
    expect(shouldPreserveSpecular({ hasSpecularTexture: true })).toBe(true);
    expect(shouldPreserveSpecular({ hasSpecularColorTexture: true })).toBe(true);
  });
});
