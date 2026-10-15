import { expect, test } from './support/fixtures';
import type { Page } from '@playwright/test';
import { openShowroom } from './support/showroom';

// Each real orbit lasts ten seconds; allow another ten for a loaded test machine.
const ORBIT_TIMEOUT_MS = 20_000;
// A load and two bounded orbit runs, with slack for assertions and input dispatch.
const TEST_TIMEOUT_MS = 120_000;
// Metres: allow spherical conversion noise while detecting a misplaced final camera.
const POSE_TOLERANCE_M = 1e-6;

interface Pose {
  position: number[];
  target: number[];
}

async function readPose(page: Page): Promise<Pose> {
  return page.evaluate(() => {
    const camera = window.archvizCamera;
    if (camera === undefined) throw new Error('the inspection camera is unavailable');
    return { position: [...camera.orbit.position], target: [...camera.orbit.target] };
  });
}

function distance(a: number[], b: number[]): number {
  return Math.hypot(...a.map((value, axis) => value - b[axis]));
}

function expectPercentiles(p50: string, p95: string): void {
  const median = Number(p50);
  const upper = Number(p95);
  expect(Number.isFinite(median), 'p50 is finite').toBe(true);
  expect(Number.isFinite(upper), 'p95 is finite').toBe(true);
  expect(median, 'p50 is non-negative').toBeGreaterThanOrEqual(0);
  expect(upper, 'p95 is at or above p50').toBeGreaterThanOrEqual(median);
}

function expectOrbitResult(text: string): void {
  // Anchor the entire result: appended results and missing millisecond units both fail.
  const result = /^CPU p50: (\d+\.\d+) ms, p95: (\d+\.\d+) ms \| (GPU: not exposed by this backend|GPU: no reading during the orbit|GPU p50: (\d+\.\d+) ms, p95: (\d+\.\d+) ms) \| budget: \d+\.\d+ ms \((inside|over)\)$/.exec(text);
  expect(result, 'one complete orbit result replaces the previous result').not.toBeNull();
  if (result === null) throw new Error(`unexpected orbit result: ${text}`);
  expectPercentiles(result[1], result[2]);
  if (result[4] !== undefined) expectPercentiles(result[4], result[5]);
  // Budget and status are printed context, not performance acceptance thresholds.
}

test('Measure runs the proof orbit and replaces its frame-time result', async ({ page, request }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  // Disable the idle tour so only Measure can move the proof-initialized camera.
  await openShowroom(page, request, '/?e2e=1&proof=1&tier=base&attract=0&music=off');
  const panel = page.getByRole('region', { name: 'Proof', exact: true });
  const button = panel.getByRole('button', { name: 'Measure', exact: true });
  const status = panel.locator('.proof-panel__status');
  const orbitTerm = panel.locator('.proof-panel__term').filter({ hasText: /^orbit$/ });
  const orbit = orbitTerm.locator('+ .proof-panel__desc');
  await expect(button).toBeEnabled();
  await expect(orbit).toHaveText('not measured');
  const proof = await readPose(page);
  expect(proof.position).toHaveLength(3);
  expect(proof.target).toHaveLength(3);
  const radius = Math.hypot(
    proof.position[0] - proof.target[0], proof.position[2] - proof.target[2],
  );
  expect(radius, 'the proof pose has a nonzero orbit radius').toBeGreaterThan(0);

  for (const run of ['first', 'second']) {
    await test.step(`${run} Measure run`, async () => {
      await button.click();
      await expect(button, 'Measure is disabled during the orbit').toBeDisabled();
      await expect(status).toHaveText('measuring...');
      // A chord longer than the radius proves at least 60 degrees of actual camera travel.
      // A skipped run cannot pass by merely updating the result or toggling the button.
      await expect.poll(async () => {
        const pose = await readPose(page);
        return distance(pose.position, proof.position);
      }, {
        timeout: ORBIT_TIMEOUT_MS,
        message: 'Measure moves the actual camera around the proof target',
      }).toBeGreaterThan(radius);
      await expect(button, 'Measure stays disabled while the camera travels').toBeDisabled();
      const travelling = await readPose(page);
      expect(distance(travelling.target, proof.target)).toBeLessThan(POSE_TOLERANCE_M);
      expect(Math.abs(travelling.position[1] - proof.position[1])).toBeLessThan(POSE_TOLERANCE_M);

      await expect(button, 'Measure is re-enabled after the orbit').toBeEnabled({
        timeout: ORBIT_TIMEOUT_MS,
      });
      await expect(status).toHaveText('');
      await expect(orbitTerm, 'the panel retains exactly one orbit row').toHaveCount(1);
      await expect(orbit).toHaveCount(1);
      expectOrbitResult((await orbit.textContent()) ?? '');
      const returned = await readPose(page);
      expect(distance(returned.position, proof.position), 'camera returns to the proof position')
        .toBeLessThan(POSE_TOLERANCE_M);
      expect(distance(returned.target, proof.target), 'camera returns to the proof target')
        .toBeLessThan(POSE_TOLERANCE_M);
    });
  }
});
