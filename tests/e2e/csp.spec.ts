import { expect, test, browserReports } from './support/fixtures';
import { PNG } from 'pngjs';
import { CONTENT_SECURITY_POLICY } from '../../src/content-security-policy';
import { backendPath, projectBackend } from './support/backend';
import { waitForSceneInitialization } from './support/ready';

interface PolicyViolation {
  directive: string;
  blockedURI: string;
  sourceFile: string;
  lineNumber: number;
}

declare global {
  interface Window {
    cspViolations?: PolicyViolation[];
  }
}

// Content initialization and a subsequent GLB decode use the existing scene/switch budgets.
const SCENE_READY_TIMEOUT = 60_000;
const LOOK_SWITCH_TIMEOUT = 30_000;
// Fetching and decoding music uses the music suite's own start budget.
const MUSIC_START_TIMEOUT = 15_000;
// Include both legacy "Refused to" errors and Chromium's newer "violates ..." diagnostics.
const POLICY_CONSOLE_MESSAGE = /content security policy|violates.*directive|refused to (?:load|connect|execute|evaluate|create|apply)/i;

test('production policy permits loading, interaction, music and screenshot without violations', async ({ page }) => {
  await page.addInitScript(() => {
    const violations: PolicyViolation[] = [];
    window.cspViolations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push({
        directive: event.effectiveDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
      });
    });
  });

  const backend = projectBackend();
  await page.setViewportSize({ width: 1440, height: 900 });

  try {
    await page.goto(backendPath('/?e2e=1&gate=on&music=off&attract=0'));
    await test.step('delivered policy matches the source before resource elements', async () => {
      const meta = page.locator('head meta[http-equiv="Content-Security-Policy" i]');
      await expect(meta).toHaveCount(1);
      await expect(meta).toHaveAttribute('content', CONTENT_SECURITY_POLICY);
      expect(await meta.evaluate((element) => {
        const resources = document.head.querySelectorAll('script, link[rel="stylesheet"], link[rel="modulepreload"]');
        return [...resources].every((resource) =>
          Boolean(element.compareDocumentPosition(resource) & Node.DOCUMENT_POSITION_FOLLOWING));
      }), 'policy precedes scripts, stylesheets and module preloads').toBe(true);
    });

    const canvas = page.locator('canvas#scene');
    await test.step('entry gate and scene decode', async () => {
      const lobby = page.locator('#entry-lobby');
      await expect(lobby).toHaveAttribute('data-state', 'idle');
      await lobby.locator('#lobby-load-btn').click();
      await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
      await expect(canvas).toHaveAttribute('data-backend', backend);
      // The lobby removes itself once the scene is revealed.
      await expect(lobby).toHaveCount(0, { timeout: SCENE_READY_TIMEOUT });
      await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);
    });

    await test.step('on-demand look decode', async () => {
      const current = await canvas.getAttribute('data-look');
      const buttons = page.locator('#looks button[data-look]');
      const ids = await buttons.evaluateAll((elements) => elements.map((element) =>
        (element as HTMLElement).dataset.look));
      const nextIndex = ids.findIndex((id) => id !== undefined && id !== current);
      expect(nextIndex, 'a different catalogue look is available').toBeGreaterThanOrEqual(0);
      await buttons.nth(nextIndex).click();
      await expect(canvas).toHaveAttribute('data-look', ids[nextIndex]!, { timeout: LOOK_SWITCH_TIMEOUT });
    });

    await test.step('music fetch, decode and playback', async () => {
      const music = page.locator('header button.music-switch');
      await expect(music).toHaveAttribute('data-music', 'off');
      await music.click();
      await expect(music).toHaveAttribute('data-music', 'playing', { timeout: MUSIC_START_TIMEOUT });
      const start = await page.evaluate(() => window.archvizMusic?.position() ?? null);
      expect(start, 'decoded music exposes its playback clock').not.toBeNull();
      await expect.poll(() => page.evaluate(() => window.archvizMusic?.position() ?? null), {
        timeout: MUSIC_START_TIMEOUT,
        message: 'decoded music playback clock advances',
      }).toBeGreaterThan(start!);
    });

    await test.step('light panel changes the scene rig', async () => {
      await page.locator('#shell-light-toggle').click();
      const panel = page.locator('#shell-light-panel');
      await expect(panel).toBeVisible();
      const before = await page.evaluate(() => window.archvizE2E?.rigState());
      await panel.locator('[data-light="key"] .lightpanel__switch').click();
      await expect.poll(() => page.evaluate(() => window.archvizE2E?.rigState())).not.toBe(before);
      await page.locator('#shell-light-toggle').click();
      await expect(panel).toBeHidden();
    });

    await test.step('share screenshot produces a PNG download', async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Screenshot', exact: true }).click(),
      ]);
      expect(await download.failure(), 'screenshot download completes').toBeNull();
      const stream = await download.createReadStream();
      if (stream === null) throw new Error('screenshot download has no readable PNG');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const png = PNG.sync.read(Buffer.concat(chunks));
      expect(png.width, 'downloaded PNG has a width').toBeGreaterThan(0);
      expect(png.height, 'downloaded PNG has a height').toBeGreaterThan(0);
    });
  } finally {
    // Allow queued violation events one task to dispatch, including when a blocked path times out.
    const violations = await page.evaluate(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve));
      return window.cspViolations ?? [];
    });
    const consoleRefusals = browserReports(page).filter((message) =>
      message.kind === 'console' && POLICY_CONSOLE_MESSAGE.test(message.text))
      .map((message) => `${message.text} [${message.location}]`);
    const details = [
      ...violations.map((entry) =>
        `${entry.directive}: blocked ${entry.blockedURI} at ${entry.sourceFile}:${entry.lineNumber}`),
      ...consoleRefusals,
    ];
    await test.info().attach('content-security-policy-diagnostics', {
      body: JSON.stringify({ violations, consoleRefusals }, null, 2),
      contentType: 'application/json',
    });
    expect.soft(details, `zero policy violations or console refusals\n${details.join('\n')}`).toEqual([]);
  }
});
