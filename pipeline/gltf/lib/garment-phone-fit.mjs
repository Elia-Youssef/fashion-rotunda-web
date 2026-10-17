// Phone-only policies split a fixed look budget before fitting its simplified surfaces.
import { simplifyPrimitive } from '@gltf-transform/functions';
import { CONTACT_TOLERANCE, surfaceParts } from './garment-coverage.mjs';
import { fitNormalInward } from './garment-normal-fit.mjs';

/** Two millimetres clears sampled contacts; 24 passes bounds the advancing face corrections.
 * The final fraction extends each moved vertex along its own accumulated displacement.
 * A positive contact tolerance must also be left as a gap, rather than admitting tiny overlaps. */
export const HALF_LOOK_FIT_POLICIES = {
  'wallis-dress': { garmentGroup: 'garment', bodyGroup: 'mannequin', bodyTriangles: 60000,
    clearance: 0.002, extraFraction: 0.1, maxPasses: 24, minimumClearance: CONTACT_TOLERANCE },
};

export const surfaceTriangles = parts => parts.reduce((sum, part) => sum + part.indices.length / 3, 0);

export function simplifySurfaceBudget(parts, target, simplifier, error, lockBorder = false) {
  const before = surfaceTriangles(parts);
  if (target <= 0) throw new Error('Surface triangle allowance must be positive');
  if (before > target) for (const primitive of new Set(parts.map(part => part.primitive))) {
    simplifyPrimitive(primitive, { simplifier, ratio: target / before, error, lockBorder });
  }
}

/** No graph access or mutation for a set/look without a policy entry. */
export function applyHalfLookFit(document, lookId, set, totalBudget, simplifier, error) {
  const policy = set === 'half' ? HALF_LOOK_FIT_POLICIES[lookId] : null;
  if (!policy) return { applied: false };
  simplifySurfaceBudget(surfaceParts(document, policy.bodyGroup), policy.bodyTriangles, simplifier, error);
  const bodyTriangles = surfaceTriangles(surfaceParts(document, policy.bodyGroup));
  simplifySurfaceBudget(surfaceParts(document, policy.garmentGroup), totalBudget - bodyTriangles, simplifier, error);
  const garmentTriangles = surfaceTriangles(surfaceParts(document, policy.garmentGroup));
  if (bodyTriangles > policy.bodyTriangles || bodyTriangles + garmentTriangles > totalBudget) {
    throw new Error(`Simplification exceeds triangle budget: body ${bodyTriangles}, garment ${garmentTriangles}`);
  }
  const fit = fitNormalInward(document, policy);
  return { applied: true, bodyTriangles, garmentTriangles, ...fit };
}
