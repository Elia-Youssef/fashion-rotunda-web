import { tuningFor } from '../../src/scene/materials';
import type { MaterialTuning } from '../../src/scene/materials';

// Shared by the scene-materials unit suites: the table checks and the applier checks both pin
// expected tunings by name, and a missing entry fails the test instead of skipping it.

export function requireTuning(name: string): MaterialTuning {
  const tuning = tuningFor(name);
  if (tuning === null) throw new Error(`expected a tuning for ${name}`);
  return tuning;
}
