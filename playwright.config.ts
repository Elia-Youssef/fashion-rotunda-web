import { defineConfig, devices } from '@playwright/test';

// The e2e gate for both renderer backends, run against the production build because
// that is what ships. The preview server owns port 4173 with --strictPort, so a collision with the
// dev server on 5173 fails loudly instead of silently testing the wrong build. reuseExistingServer
// stays false on purpose: a stale preview server once served a pre-change build and the results
// could not be trusted.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  // Four workers: the webgl2 project renders in software, and a dozen pages loading eleven
  // megabytes and rasterising the room at once turned every wait into a timeout. Ninety seconds
  // per test is the budget that software rendering needs for a load plus a look switch.
  workers: 4,
  retries: 0,
  reporter: 'list',
  timeout: 90_000,
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      // Bundled Chromium, headless: this is the project CI runs on Linux.
      name: 'webgl2',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:4173',
        headless: true,
      },
    },
    {
      // The installed Google Chrome, which keeps the real GPU in headless mode (the bundled
      // Chromium's headless shell renders WebGPU black). Headless by default, so a run opens no
      // window; pass --headed to watch a run or to take readings in a visible window. Never add
      // --use-angle=gl: it hides the GPU adapter and forces the WebGL 2 fallback. Local only; CI
      // runs the webgl2 project.
      name: 'webgpu',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        headless: true,
        // A headed run would play the page's music through the speakers; keep it muted either way.
        launchOptions: { args: ['--mute-audio'] },
        baseURL: 'http://localhost:4173',
      },
    },
  ],
});
