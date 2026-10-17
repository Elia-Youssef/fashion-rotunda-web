import type { Rig, RigLight, RigStudioLightId } from '../../src/lighting/rig';

// The studio-light lookup shared by the lighting-rig suites: one light of a rig by id, and
// a throw when the id is absent, so a misaddressed assertion fails the test run.

export function studioLight(rig: Rig, id: RigStudioLightId): RigLight {
  const found = rig.lights.find((entry) => entry.id === id);
  if (!found) throw new Error(`no light ${id} in the rig`);
  return found;
}
