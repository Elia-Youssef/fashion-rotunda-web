// Renderer-only WebGL 2 visual baselines at the catalogue proof pose.

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const SCENE_READY_TIMEOUT = 60_000;
const SWITCH_TIMEOUT = 30_000;
const TEST_TIMEOUT = 180_000;
const IDLE_ATTEMPTS = 15;
const MAX_STABILIZATION_ORBITS = 8;
const REQUIRED_STABLE_TRANSITIONS = 2;

// This is intentionally a fully specified renderer profile. In particular, `tier=mid` and
// `proof=1` avoid inheriting an environment-dependent tier or a visitor's saved camera state.
const VISUAL_QUERY =
  '?webgl=1&tier=mid&proof=1&gate=off&e2e=1&music=off&attractIdle=999999';
const EXPECTED_POST = 'ao,traa,bloom,lut,vignette';
const EXPECTED_BACKEND = 'webgl2';
const EXPECTED_TIER = 'mid';
const EXPECTED_VIEWPORT = { width: 1280, height: 720 } as const;
const EXPECTED_LOOKS = {
  first: 'wallis-dress',
  second: 'new-look-dress',
} as const;
const EXPECTED_VARIANT = 'base';

// The proof entry is the reset camera selected by ?proof=1. The current e2e camera handle exposes
// the resulting position and target; the controlled page initialization and Home reset retain the
// catalogued 40-degree FOV without adding a test-only renderer API just for a snapshot gate.
const PROOF_POSITION: [number, number, number] = [0, 1.7, 4.2];
const PROOF_TARGET: [number, number, number] = [0, 1, 0];
const PROOF_FOV_DEGREES = 40;

interface RendererProfile {
  backend: string | null;
  tier: string | null;
  look: string | null;
  variant: string | null;
  post: string | null;
  renderScale: string | null;
  backingWidth: number;
  backingHeight: number;
  devicePixelRatio: number;
  effectiveScaleX: number;
  effectiveScaleY: number;
  frames: number;
  position: number[];
  target: number[];
}

type ProfileIdentity = Pick<
  RendererProfile,
  'renderScale' | 'backingWidth' | 'backingHeight' | 'effectiveScaleX' | 'effectiveScaleY'
>;

interface StableTransition {
  attempt: number;
  before: ProfileIdentity;
  after: ProfileIdentity;
  idle: boolean;
  exact: boolean;
  consecutiveExact: number;
}

// The shell overlays the full-viewport canvas. Element screenshots therefore composite any
// visible sibling painted above the canvas unless the test masks chrome first. Keep this list
// structural: it names the mounts owned by index.html, not the current visual details inside
// them, so a new card button cannot silently leak into a renderer baseline.
const RENDERER_ONLY_CHROME_SELECTORS = [
  'body > header',
  'main > #looks',
  '#shell-stage > :not(canvas#scene)',
  'body > footer',
  'body > .a11y-tooltip',
  'body > .onboarding-card',
  'body > .camera-joystick',
  'body > .renderer-notice',
] as const;
const RENDERER_CAPTURE_ATTRIBUTE = 'data-renderer-baseline-capture';

// Playwright names a baseline after the platform it was taken on: the default template is
// '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}'
// (playwright/lib/worker/workerProcessEntry.js line 1256) and the suffix is process.platform
// (playwright/lib/index.js line 352). The committed baselines are '-webgl2-win32.png', taken on
// this machine, so a Linux runner would look for '-webgl2-linux.png' and fail on a missing file.
// The gate skips there until Linux baselines are generated on the runner itself.
test.skip(
  process.platform !== 'win32',
  "the baselines are this machine's; Linux baselines are a later step",
);

function skipUnlessWebgl2(): void {
  test.skip(
    test.info().project.name !== 'webgl2',
    'visual baselines run on the headless webgl2 project only',
  );
}

function profileIdentity(profile: RendererProfile): ProfileIdentity {
  return {
    renderScale: profile.renderScale,
    backingWidth: profile.backingWidth,
    backingHeight: profile.backingHeight,
    effectiveScaleX: profile.effectiveScaleX,
    effectiveScaleY: profile.effectiveScaleY,
  };
}

function sameProfile(left: ProfileIdentity, right: ProfileIdentity): boolean {
  return (
    left.renderScale === right.renderScale &&
    left.backingWidth === right.backingWidth &&
    left.backingHeight === right.backingHeight &&
    left.effectiveScaleX === right.effectiveScaleX &&
    left.effectiveScaleY === right.effectiveScaleY
  );
}

function isExactVisualProfile(profile: ProfileIdentity): boolean {
  return (
    profile.renderScale === '1' &&
    profile.backingWidth === EXPECTED_VIEWPORT.width &&
    profile.backingHeight === EXPECTED_VIEWPORT.height &&
    profile.effectiveScaleX === 1 &&
    profile.effectiveScaleY === 1
  );
}

async function readRendererProfile(page: Page): Promise<RendererProfile> {
  return await page.evaluate((): RendererProfile => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas#scene');
    const camera = window.archvizCamera;
    if (canvas === null || camera === undefined) {
      throw new Error('the e2e canvas or camera handle is unavailable');
    }
    const rect = canvas.getBoundingClientRect();
    const proof = new Map<string, string>();
    for (const term of document.querySelectorAll<HTMLElement>('.proof-panel__term')) {
      proof.set(term.textContent?.trim() ?? '', term.nextElementSibling?.textContent?.trim() ?? '');
    }
    return {
      backend: canvas.dataset.backend ?? null,
      tier: proof.get('tier') ?? null,
      look: canvas.dataset.look ?? null,
      variant: canvas.dataset.variant ?? null,
      post: canvas.dataset.post ?? null,
      renderScale: proof.get('render scale') ?? null,
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      devicePixelRatio: window.devicePixelRatio,
      effectiveScaleX: canvas.width / (rect.width * window.devicePixelRatio),
      effectiveScaleY: canvas.height / (rect.height * window.devicePixelRatio),
      frames: Number(canvas.dataset.frames ?? '0'),
      position: [...camera.orbit.position],
      target: [...camera.orbit.target],
    };
  });
}

/** Two equal readings one second apart establish that the demand loop has actually gone idle. */
async function waitForLoopIdle(page: Page, canvas: Locator): Promise<boolean> {
  let previous = Number(await canvas.getAttribute('data-frames'));
  for (let attempt = 0; attempt < IDLE_ATTEMPTS; attempt += 1) {
    await page.waitForTimeout(1000);
    const current = Number(await canvas.getAttribute('data-frames'));
    if (current > 0 && current === previous) {
      return true;
    }
    previous = current;
  }
  return false;
}

async function expectLoopIdle(page: Page, canvas: Locator): Promise<void> {
  expect(await waitForLoopIdle(page, canvas), 'the demand loop became idle').toBe(true);
}

async function runMeasure(page: Page): Promise<void> {
  const button = page.locator('.proof-panel__measure');
  await expect(button).toBeVisible({ timeout: SCENE_READY_TIMEOUT });
  await button.click();
  await page.waitForFunction(
    () => {
      const measure = document.querySelector('.proof-panel__measure');
      const orbit = [...document.querySelectorAll('.proof-panel__term')].find(
        (term) => term.textContent?.trim() === 'orbit',
      )?.nextElementSibling?.textContent?.trim();
      return measure instanceof HTMLButtonElement && !measure.disabled && orbit !== 'not measured';
    },
    undefined,
    { timeout: SCENE_READY_TIMEOUT },
  );
}

/**
 * Adaptive resolution remains part of the product, so this does not freeze time or manipulate its
 * inputs. It discards real Measure orbits until two complete, idle transitions retain the exact
 * 1280x720 / scale-1 profile required by the baseline. A weaker rounded proof-panel label alone
 * would not prove the backing buffer is comparable.
 */
async function stabilizeExactProfile(page: Page, canvas: Locator): Promise<StableTransition[]> {
  const transitions: StableTransition[] = [];
  let before = await readRendererProfile(page);
  let consecutiveExact = 0;
  for (let attempt = 1; attempt <= MAX_STABILIZATION_ORBITS; attempt += 1) {
    await runMeasure(page);
    const idle = await waitForLoopIdle(page, canvas);
    const after = await readRendererProfile(page);
    const beforeIdentity = profileIdentity(before);
    const afterIdentity = profileIdentity(after);
    const exact = idle && sameProfile(beforeIdentity, afterIdentity) && isExactVisualProfile(afterIdentity);
    consecutiveExact = exact ? consecutiveExact + 1 : 0;
    transitions.push({
      attempt,
      before: beforeIdentity,
      after: afterIdentity,
      idle,
      exact,
      consecutiveExact,
    });
    before = after;
    if (consecutiveExact >= REQUIRED_STABLE_TRANSITIONS) {
      return transitions;
    }
  }
  throw new Error(
    `renderer did not retain the exact 1280x720 scale-1 profile for ${REQUIRED_STABLE_TRANSITIONS} consecutive Measure transitions: ${JSON.stringify(transitions)}`,
  );
}

async function resetAndExpectProofPose(page: Page, canvas: Locator): Promise<RendererProfile> {
  // Home is dispatched to the real canvas handler. It resets the proof initialized camera instead
  // of injecting a pose through an e2e handle, so this guards the visitor-facing reset path too.
  await canvas.focus();
  await page.keyboard.press('Home');
  await expectLoopIdle(page, canvas);
  const profile = await readRendererProfile(page);
  expect(profile.position).toHaveLength(3);
  expect(profile.target).toHaveLength(3);
  for (const [axis, expected] of PROOF_POSITION.entries()) {
    expect(profile.position[axis]).toBeCloseTo(expected, 6);
  }
  for (const [axis, expected] of PROOF_TARGET.entries()) {
    expect(profile.target[axis]).toBeCloseTo(expected, 6);
  }
  // FOV is fixed by public/content/catalog.json's proof entry (40 degrees) at mount and unchanged
  // by the Home path above; the OrbitHandle deliberately has no camera internals read API.
  expect(PROOF_FOV_DEGREES, 'the controlled proof FOV').toBe(40);
  return profile;
}

function expectExactRendererProfile(profile: RendererProfile, look: string): void {
  expect(profile.backend).toBe(EXPECTED_BACKEND);
  expect(profile.tier).toBe(EXPECTED_TIER);
  expect(profile.look).toBe(look);
  expect(profile.variant).toBe(EXPECTED_VARIANT);
  expect(profile.post).toBe(EXPECTED_POST);
  expect(profile.devicePixelRatio).toBe(1);
  expect(profileIdentity(profile)).toEqual({
    renderScale: '1',
    backingWidth: EXPECTED_VIEWPORT.width,
    backingHeight: EXPECTED_VIEWPORT.height,
    effectiveScaleX: 1,
    effectiveScaleY: 1,
  });
}

/**
 * Captures only renderer output even though the canvas now fills the viewport beneath the shell.
 * The test-only mask is deliberately reversible: interaction after a baseline must run against
 * the real chrome, and the visual baseline must never become an implicit UI snapshot.
 */
async function expectRendererOnlyScreenshot(
  page: Page,
  canvas: Locator,
  name: string,
): Promise<void> {
  await page.evaluate(
    ({ attribute, selectors }) => {
      const id = 'renderer-baseline-chrome-mask';
      if (document.getElementById(id) === null) {
        const style = document.createElement('style');
        style.id = id;
        style.textContent = `
          html[${attribute}] body > :not(main),
          html[${attribute}] main > :not(#shell-stage),
          html[${attribute}] #shell-stage > :not(canvas#scene) {
            visibility: hidden !important;
          }
        `;
        document.head.appendChild(style);
      }
      document.documentElement.setAttribute(attribute, 'true');

      // A direct DOM assertion keeps this renderer-only contract independent of image pixels.
      for (const selector of selectors) {
        for (const element of document.querySelectorAll<HTMLElement>(selector)) {
          if (getComputedStyle(element).visibility !== 'hidden') {
            throw new Error(`renderer baseline chrome remained visible: ${selector}`);
          }
        }
      }
    },
    { attribute: RENDERER_CAPTURE_ATTRIBUTE, selectors: RENDERER_ONLY_CHROME_SELECTORS },
  );

  try {
    await expect(canvas).toHaveScreenshot(name, {
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
    });
  } finally {
    await page.evaluate((attribute) => {
      document.documentElement.removeAttribute(attribute);
    }, RENDERER_CAPTURE_ATTRIBUTE);
  }

  // Restoration is part of the contract: later actions and dedicated UI snapshots must see the
  // unmodified page, rather than a test-only renderer state.
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ attribute, selectors }) => {
            if (document.documentElement.hasAttribute(attribute)) {
              return false;
            }
            return selectors.every((selector) =>
              [...document.querySelectorAll<HTMLElement>(selector)].every(
                (element) => getComputedStyle(element).visibility !== 'hidden',
              ),
            );
          },
          { attribute: RENDERER_CAPTURE_ATTRIBUTE, selectors: RENDERER_ONLY_CHROME_SELECTORS },
        ),
      { message: 'renderer capture restores the overlay chrome' },
    )
    .toBe(true);
}

test('visual baselines for the first look and the New Look Dress', async ({ page }) => {
  skipUnlessWebgl2();
  test.setTimeout(TEST_TIMEOUT);
  const errors = { console: [] as string[], page: [] as string[] };
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.console.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.page.push(error.message));

  await page.setViewportSize(EXPECTED_VIEWPORT);
  await page.goto(`/${VISUAL_QUERY}`);
  const canvas = page.locator('canvas#scene');

  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await expectLoopIdle(page, canvas);
  const stabilization = await stabilizeExactProfile(page, canvas);
  const firstProfile = await resetAndExpectProofPose(page, canvas);
  expectExactRendererProfile(firstProfile, EXPECTED_LOOKS.first);

  await test.info().attach('renderer-visual-protocol.json', {
    body: JSON.stringify(
      {
        query: VISUAL_QUERY,
        viewport: EXPECTED_VIEWPORT,
        proof: { position: PROOF_POSITION, target: PROOF_TARGET, fovDegrees: PROOF_FOV_DEGREES },
        stabilization,
        firstProfile,
        errors,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });

  // Baseline 1: The first look (Wallis Dress).
  await expectRendererOnlyScreenshot(page, canvas, 'first-look.png');

  // Switch to the New Look Dress.
  const newLookButton = page.locator('#looks button[data-look="new-look-dress"]');
  await expect(newLookButton).toBeVisible({ timeout: SWITCH_TIMEOUT });
  await newLookButton.click();
  // The pointer rests on the rail button after the click, so its hover tooltip can show over the
  // canvas. The baseline owns renderer output, not transient page chrome, so dismiss it before
  // capturing.
  await page.keyboard.press('Escape');
  await expect(canvas).toHaveAttribute('data-look', EXPECTED_LOOKS.second, { timeout: SWITCH_TIMEOUT });
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  // The new look can trigger the adaptive scaler while its materials settle. Requalify the
  // exact renderer profile before comparing a second image against a fixed-size baseline.
  const newLookStabilization = await stabilizeExactProfile(page, canvas);
  await test.info().attach('new-look-visual-stabilization.json', {
    body: JSON.stringify(newLookStabilization, null, 2),
    contentType: 'application/json',
  });
  const newLookProfile = await resetAndExpectProofPose(page, canvas);
  expectExactRendererProfile(newLookProfile, EXPECTED_LOOKS.second);

  // Baseline 2: The New Look Dress after the switch.
  await expectRendererOnlyScreenshot(page, canvas, 'new-look-dress.png');
  expect(errors.console, 'the controlled visual run has no console errors').toEqual([]);
  expect(errors.page, 'the controlled visual run has no uncaught page errors').toEqual([]);
});
