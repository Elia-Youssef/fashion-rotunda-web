import { describe, expect, it } from 'vitest';

import { LIGHTING_PRESETS, PRESET_ORDER } from '../../src/lighting/presets';

describe('lighting presets removal (UI-5)', () => {
  it('has zero active presets per UI-5 contract', () => {
    expect(PRESET_ORDER).toHaveLength(0);
    expect(Object.keys(LIGHTING_PRESETS)).toHaveLength(0);
  });
});
