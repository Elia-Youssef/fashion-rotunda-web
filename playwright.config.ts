import { defineConfig, devices } from '@playwright/test';

// G0.7: the e2e gate for both renderer backends, run against the production build because
// that is what ships. The preview server owns port 4173 with --strictPort, so a collision with the
// dev server on 5173 fails loudly instead of silently testing the wrong build. reuseExistingServer
// stays false on purpose: a stale preview server once served a pre-change build and the results
// could not be trusted.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  timeout: 60_000,
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
      // Headless Chromium renders WebGPU black, so the WebGPU project runs headed on the installed
      // Google Chrome. Local only; CI runs the webgl2 project.
      name: 'webgpu',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        headless: false,
        baseURL: 'http://localhost:4173',
      },
    },
  ],
});
