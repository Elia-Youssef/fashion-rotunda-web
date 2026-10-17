// Per-mesh exports omit Blueprint component transforms. Record placements by look and source
// filename so assembly restores them at the part boundary without changing mesh-local transforms.
// The hat values reproduce the accepted worn placement: one-tenth size about the look origin,
// 1 cm left and 2.5 cm toward the front viewer, with no vertical offset. Checked against renders
// on 2026-10-17; these are the accepted placement, not a recovered Blueprint transform.
export const GARMENT_PLACEMENTS = {
  'zoot-suit': {
    'SM_ZootSuit_Hat.glb': {
      scale: [0.1, 0.1, 0.1],
      translation: [-0.01, 0, 0.025],
    },
  },
};
