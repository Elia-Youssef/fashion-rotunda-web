import { describe, expect, it } from 'vitest';

import { LIGHTING_PRESETS, PRESET_ORDER } from '../../src/lighting/presets';

describe('lighting presets removal', () => {
  it('has zero active presets', () => {
    expect(PRESET_ORDER).toHaveLength(0);
    expect(Object.keys(LIGHTING_PRESETS)).toHaveLength(0);
  });
});
