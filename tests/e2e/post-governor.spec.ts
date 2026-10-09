import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// The bidirectional frame-time governor on actual, headed WebGPU. The deterministic
// harness behind `?e2e=1` (window.archvizE2E.governor) is the only thing this spec drives: it
// blocks real-frame samples and injects observations with explicit workMs/nowMs/eligibility, so
// the 80% threshold, the ten-second qualification and the ten-second cooldown are proven on the
// exact state machine the page runs, on the real chain, with the level applied through render().
//
// The synthetic clock advances only when samples are injected; the governor's diagnostics are
// reported against the last observed sample, so every reading below is deterministic.

const SCENE_READY_TIMEOUT = 60_000;
const POLL_TIMEOUT = 15_000;
/** The high tier's frame budget and the comfortable threshold derived from it. */
const BUDGET_MS = 16.7;
const THRESHOLD_MS = BUDGET_MS * 0.8;

/**
 * Where the proof-panel screenshots land. Defaults to ephemeral test-results to avoid mutating
 * historical evidence during ordinary test runs; explicit evidence runs set process.env.EVIDENCE_DIR.
 */
const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? 'test-results/post-governor';
if (!fs.existsSync(EVIDENCE_DIR)) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

interface GovernorDiagnosticsJson {
  level: string;
  recoveryEligible: boolean;
  activity: string;
  consecutiveOverBudget: number;
  patience: number;
  cooldownRemainingMs: number;
  recoveryElapsedMs: number;
  recoveryQualificationMs: number;
  recoveryThresholdMs: number;
  budgetMs: number;
  lastP95Ms: number | null;
  events: readonly {
    direction: 'down' | 'up';
    from: string;
    to: string;
    p95Ms: number;
    budgetMs: number;
    atMs: number;
    reason: string;
  }[];
}

function watchPageErrors(page: Page, errors: string[]): void {
  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`);
    }
  });
}

async function diagnostics(page: Page): Promise<GovernorDiagnosticsJson | null> {
  return await page.evaluate(() => window.archvizE2E?.governor.diagnostics() ?? null);
}

/**
 * The public e2e rig handle is the complete visitor-controllable lighting state: three local-light
 * enabled/intensity/color tuples, daylight, and any non-default coordinated exposure. The governor
 * must never rewrite it while rebuilding only post-processing slices.
 */
async function rigState(page: Page): Promise<string> {
  const state = await page.evaluate(() => window.archvizE2E?.rigState() ?? null);
  if (state === null) throw new Error('the e2e lighting rig handle is unavailable');
  return state;
}

async function captureProofPanel(page: Page, path: string): Promise<void> {
  await page.locator('.proof-panel').evaluate((el) => {
    el.style.maxHeight = 'none';
    el.style.position = 'relative';
    el.style.zIndex = '99999';
    el.style.background = '#1a1e24';
    const dl = el.querySelector('.proof-panel__list') as HTMLElement | null;
    if (dl) {
      dl.style.maxHeight = 'none';
      dl.style.overflow = 'visible';
    }
  });
  await page.evaluate(() => {
    const card = document.querySelector('#shell-card') as HTMLElement | null;
    if (card) {
      card.style.visibility = 'hidden';
    }
  });
  await page.locator('.proof-panel').screenshot({ path });
  await page.evaluate(() => {
    const card = document.querySelector('#shell-card') as HTMLElement | null;
    if (card) {
      card.style.visibility = '';
    }
  });
}

test('the governor degrades, holds its cooldown, and recovers on headed webgpu', async ({
  page,
}) => {
  test.skip(
    test.info().project.name !== 'webgpu',
    'the governor is WebGPU enhanced-tier behaviour; this test runs on the headed webgpu project only',
  );
  test.setTimeout(180_000);
  const errors: string[] = [];
  watchPageErrors(page, errors);

  // 1. Actual WebGPU or the run is a failure, never a silent WebGL2 substitute.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?e2e=1&gate=off&tier=high&music=off&proof=1');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu', { timeout: SCENE_READY_TIMEOUT });
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  // 2. The guarded deterministic harness. A missing governor here is a failure, not a skip:
  // this URL is the enhanced WebGPU path and must have one.
  await expect
    .poll(() => page.evaluate(() => (window.archvizE2E?.governor !== undefined)), {
      timeout: POLL_TIMEOUT,
      message: 'the e2e governor harness is mounted',
    })
    .toBe(true);
  const before = await diagnostics(page);
  expect(before, 'the enhanced WebGPU page runs a governor').not.toBeNull();
  expect(before?.level).toBe('full');
  expect(before?.budgetMs).toBeCloseTo(BUDGET_MS, 5);
  expect(before?.recoveryThresholdMs).toBeCloseTo(THRESHOLD_MS, 5);
  const backend = await canvas.getAttribute('data-backend');
  const gpuName = (await page.locator('.proof-panel').textContent()) ?? '';
  const rigBeforeGovernor = await rigState(page);
  expect(rigBeforeGovernor, 'the controlled page begins with the complete default lighting rig').toBe(
    'v2;key,1,15,ffffff;fill,0,7,ffffff;back,0,7,ffffff;day,0.5',
  );
  await page.evaluate(() => window.archvizE2E?.governor.setDeterministic(true));

  // 3. Two complete over-budget windows (60 samples each) drop the normal High SSR-only graph
  // straight to no-ssr. The synthetic clock advances only inside drive(), so gaps and cooldown
  // boundaries are exact.
  let t = 1_000;
  const drive = async (
    count: number,
    workMs: number,
    gapMs: number,
    eligible: boolean,
  ): Promise<GovernorDiagnosticsJson | null> => {
    const result = await page.evaluate(
      ({ start, count, workMs, gapMs, eligible }) => {
        const governor = window.archvizE2E!.governor;
        let at = start;
        let last: GovernorDiagnosticsJson | null = null;
        for (let i = 0; i < count; i += 1) {
          at += gapMs;
          last = governor.observe(workMs, at, eligible);
        }
        return last;
      },
      { start: t, count, workMs, gapMs, eligible },
    );
    t += count * gapMs;
    return result;
  };

  const downgraded = await drive(120, 40, 100, true);
  expect(downgraded?.level, 'two over-budget windows remove SSR in one level').toBe('no-ssr');

  // 4. The rendered state reflects the level: data-governor is published from the committed
  // chain, one requested frame after the decision.
  await expect
    .poll(async () => (await canvas.getAttribute('data-governor')) ?? '', {
      timeout: POLL_TIMEOUT,
      message: 'data-governor carries the committed no-ssr level',
    })
    .toContain('level=no-ssr');
  await expect
    .poll(async () => {
      const post = (await canvas.getAttribute('data-post')) ?? '';
      return post.includes('traa') && !post.includes('ssgi') && !post.includes('ssr');
    }, {
      timeout: POLL_TIMEOUT,
      message: 'the applied no-ssr graph keeps TRAA and omits both SSR and SSGI',
    })
    .toBe(true);
  const rigAfterDowngrade = await rigState(page);
  expect(
    rigAfterDowngrade,
    'governor downgrade changes post processing only, never local lights, daylight, or exposure',
  ).toBe(rigBeforeGovernor);
  const downReading = await canvas.getAttribute('data-governor');
  await expect
    .poll(async () => (await page.locator('.proof-panel').textContent()) ?? '', {
      timeout: POLL_TIMEOUT,
      message: 'proof panel text reflects no-ssr downgrade',
    })
    .toContain('no-ssr');
  await captureProofPanel(page, `${EVIDENCE_DIR}/proof-panel-after-downgrade.png`);

  // 5. Another immediate overload is blocked by the cooldown: two more complete over-budget
  // windows arrive 1.2 s after the decision, inside the 10 s cooldown.
  const blocked = await drive(120, 40, 10, true);
  expect(blocked?.level, 'cooldown blocks the next SSR-only downgrade').toBe('no-ssr');
  expect(blocked?.consecutiveOverBudget).toBeGreaterThanOrEqual(2);
  expect(blocked?.cooldownRemainingMs).toBeGreaterThan(0);

  // 6. Comfortably-under-budget windows for less than ten seconds do not recover. The first
  // complete window ends 5.9 s into the run (and the cooldown is still running besides).
  const shortGood = await drive(60, 8, 100, true);
  expect(shortGood?.level, 'under ten seconds of good frames: no recovery').toBe('no-ssr');
  expect(shortGood?.recoveryElapsedMs).toBeGreaterThan(5_000);
  expect(shortGood?.recoveryElapsedMs).toBeLessThan(10_000);

  // 8a. A CSS-box resize during qualification: the level, the cooldown-free status and the
  // accumulated qualification all survive the post-chain rebuild.
  const elapsedBeforeResize = shortGood?.recoveryElapsedMs ?? 0;
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect
    .poll(async () => (await canvas.getAttribute('data-governor')) ?? '', { timeout: POLL_TIMEOUT })
    .toContain('level=no-ssr');
  const afterResize = await drive(1, 8, 100, true);
  expect(afterResize?.level, 'resize does not change the level').toBe('no-ssr');
  expect(
    afterResize?.recoveryElapsedMs ?? 0,
    'resize preserves the accumulated qualification (a restart would read ~100 ms)',
  ).toBeGreaterThan(elapsedBeforeResize);

  // 7. Completing ten seconds of continuous eligible good frames recovers exactly one level.
  // Windows complete every 6 s of synthetic time; the second completion holds a 11.9 s run and
  // the decision cooldown (10 s) has long expired.
  const recovered = await drive(120, 8, 100, true);
  expect(recovered?.level, 'ten seconds of good frames recover one level').toBe('full');
  const upEvents = recovered?.events.filter((event) => event.direction === 'up') ?? [];
  expect(upEvents.length, 'exactly one recovery').toBe(1);
  expect(upEvents[0]?.from).toBe('no-ssr');
  expect(upEvents[0]?.to).toBe('full');
  expect(upEvents[0]?.reason).toContain('after');
  await expect
    .poll(async () => (await canvas.getAttribute('data-governor')) ?? '', {
      timeout: POLL_TIMEOUT,
      message: 'data-governor carries the recovered full level',
    })
    .toContain('level=full');
  await expect
    .poll(async () => (await canvas.getAttribute('data-governor')) ?? '', {
      timeout: POLL_TIMEOUT,
      message: 'the recovered governor publishes its active cooldown before evidence is captured',
    })
    .toContain('activity=cooldown');
  await expect
    .poll(async () => (await canvas.getAttribute('data-governor-log')) ?? '', {
      timeout: POLL_TIMEOUT,
      message: 'the committed recovery event is published before the recovery evidence is captured',
    })
    .toContain('"direction":"up"');
  await expect
    .poll(async () => (await page.locator('.proof-panel').textContent()) ?? '', {
      timeout: POLL_TIMEOUT,
      message: 'the proof panel reflects the committed recovery before it is captured',
    })
    .toContain('up no-ssr \u2192 full');
  const rigAfterRecovery = await rigState(page);
  expect(
    rigAfterRecovery,
    'governor recovery restores post processing only, never local lights, daylight, or exposure',
  ).toBe(rigBeforeGovernor);
  // This evidence must depict the actual recovered state, not the later post-lifecycle
  // qualification run. The filename is retained for the report contract.
  await captureProofPanel(page, `${EVIDENCE_DIR}/proof-panel-after-recovery.png`);

  // 8b. A resize during the recovery's cooldown keeps the remaining cooldown.
  const cooldownBefore = await diagnostics(page);
  expect(cooldownBefore?.cooldownRemainingMs).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  const cooldownAfter = await diagnostics(page);
  expect(cooldownAfter?.level, 'resize during cooldown keeps the level').toBe('full');
  expect(
    cooldownAfter?.cooldownRemainingMs ?? 0,
    'resize during cooldown preserves the remaining cooldown',
  ).toBeGreaterThan(0);
  const recoveredReading = await canvas.getAttribute('data-governor');

  // 10. Build a fresh qualifying run, then dispatch the real page lifecycle events rather than
  // merely injecting an ineligible synthetic sample. `pagehide` must clear qualification
  // immediately; its state is published on the next real draw. `pageshow` may restore eligibility
  // only because this visible, fully loaded, settled `gate=off` page satisfies every prerequisite.
  // The governor continues observing at `full`, so explicitly reset the earlier post-recovery run
  // before preparing the 5.9-second pre-lifecycle stretch.
  const preparedReset = await drive(1, 8, 100, false);
  expect(preparedReset?.recoveryElapsedMs).toBe(0);
  const beforeLifecycle = await drive(60, 8, 100, true);
  expect(beforeLifecycle?.recoveryElapsedMs).toBeGreaterThan(5_000);
  expect(beforeLifecycle?.recoveryElapsedMs).toBeLessThan(10_000);

  const afterPagehide = await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    return window.archvizE2E?.governor.diagnostics() ?? null;
  });
  expect(afterPagehide, 'pagehide leaves the enhanced governor observable').not.toBeNull();
  expect(afterPagehide?.recoveryEligible, 'pagehide immediately blocks recovery').toBe(false);
  expect(afterPagehide?.recoveryElapsedMs, 'pagehide clears qualification immediately').toBe(0);
  // The canvas/proof bridge intentionally publishes only after a drawn frame, so a visible level
  // cannot get ahead of the graph that actually rendered it. Deterministic sampling excludes this
  // real wake frame from the synthetic decision stream.
  await page.mouse.move(400, 300);
  await expect
    .poll(async () => (await canvas.getAttribute('data-governor')) ?? '', {
      timeout: POLL_TIMEOUT,
      message: 'the next drawn frame publishes the pagehide recovery block',
    })
    .toContain('eligible=0');
  await expect
    .poll(async () => (await page.locator('.proof-panel').textContent()) ?? '', {
      timeout: POLL_TIMEOUT,
      message: 'the proof panel refreshes to show the pagehide recovery block',
    })
    .toContain('eligible=0');

  const afterPageshow = await page.evaluate(() => {
    window.dispatchEvent(new Event('pageshow'));
    return window.archvizE2E?.governor.diagnostics() ?? null;
  });
  expect(afterPageshow, 'pageshow leaves the enhanced governor observable').not.toBeNull();
  expect(afterPageshow?.recoveryEligible, 'valid visible pageshow restores eligibility').toBe(true);
  expect(afterPageshow?.recoveryElapsedMs, 'pageshow never restores old qualification').toBe(0);
  await page.mouse.move(401, 300);
  await expect
    .poll(async () => (await canvas.getAttribute('data-governor')) ?? '', {
      timeout: POLL_TIMEOUT,
      message: 'the next drawn frame publishes the valid pageshow eligibility state',
    })
    .toContain('eligible=1');

  // The next good stretch starts from zero. Had pagehide not invalidated the prior run, this
  // reading would include the 5.9-second pre-lifecycle stretch and could recover too early.
  const freshShort = await drive(60, 8, 100, true);
  expect(freshShort?.level).toBe('full');
  expect(freshShort?.recoveryElapsedMs).toBeGreaterThan(5_000);
  expect(freshShort?.recoveryElapsedMs).toBeLessThan(10_000);

  // 11. The proof panel shows the ordered history: the downgrade first, the recovery second.
  // The published attributes freeze when the loop idles, so wake one real frame first; it
  // republishes from the current committed governor state (deterministic mode keeps the real
  // frame's own work time out of the sample stream).
  await page.mouse.move(400, 300);
  await expect
    .poll(async () => (await canvas.getAttribute('data-governor-log')) ?? '', {
      timeout: POLL_TIMEOUT,
      message: 'the committed log attribute carries both directions after the wake frame',
    })
    .toContain('"direction":"up"');
  const panelText = (await page.locator('.proof-panel').textContent()) ?? '';
  const downIndex = panelText.indexOf('down full \u2192 no-ssr');
  const upIndex = panelText.indexOf('up no-ssr \u2192 full');
  expect(downIndex, 'the panel shows the downgrade').toBeGreaterThan(-1);
  expect(upIndex, 'the panel shows the recovery').toBeGreaterThan(-1);
  expect(downIndex, 'the panel shows the downgrade before the recovery').toBeLessThan(upIndex);
  expect(panelText).toContain('p95 40.0 ms > 16.7 ms');
  const logAttribute = await canvas.getAttribute('data-governor-log');
  expect(logAttribute ?? '', 'the canvas log attribute carries both directions').toContain(
    '"direction":"down"',
  );
  expect(logAttribute ?? '').toContain('"direction":"up"');

  // Evidence: the readings and the backend identity, saved for the report.
  console.log(
    JSON.stringify(
      {
        backend,
        gpuPanelTextIncludesGpu: gpuName.includes('gpu'),
        governorBefore: before,
        afterDowngrade: downReading,
        afterRecovery: recoveredReading,
        rigBeforeGovernor,
        rigAfterDowngrade,
        rigAfterRecovery,
        cooldownRemainingBeforeResize: cooldownBefore?.cooldownRemainingMs ?? null,
        cooldownRemainingAfterResize: cooldownAfter?.cooldownRemainingMs ?? null,
      },
      null,
      2,
    ),
  );

  // 12. Zero page errors and zero console errors.
  expect(errors, 'no page errors and no console errors').toEqual([]);
});

test('no governor exists on the webgl2 backend or forced post slices', async ({ page }) => {
  test.skip(
    test.info().project.name !== 'webgl2',
    'the webgl2 project is the CI-owned project this absence check runs on',
  );
  const errors: string[] = [];
  watchPageErrors(page, errors);

  await page.goto('/?e2e=1&gate=off');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-backend', 'webgl2', { timeout: SCENE_READY_TIMEOUT });
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await expect
    .poll(async () => (await canvas.getAttribute('data-governor')) ?? '', {
      timeout: POLL_TIMEOUT,
      message: 'data-governor publishes the off status once the chain exists',
    })
    .toBe('off');
  expect(await canvas.getAttribute('data-governor-log')).toBe('[]');

  await page.goto('/?e2e=1&gate=off&post=max');
  await expect(canvas).toHaveAttribute('data-backend', 'webgl2', { timeout: SCENE_READY_TIMEOUT });
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await expect
    .poll(async () => (await canvas.getAttribute('data-governor')) ?? '', { timeout: POLL_TIMEOUT })
    .toBe('off');
  expect(errors, 'no page errors and no console errors').toEqual([]);
});
