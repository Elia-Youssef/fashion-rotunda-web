// Launches the installed Chrome through Playwright and prints the WebGPU adapter it receives.
// Usage: node tools/gpu-check.mjs [url]. The default URL is the dev server; any secure-context page works.
// Why: on a dual-GPU laptop Chrome silently runs on the integrated GPU unless Windows assigns it the
// discrete one, and every performance number depends on knowing which GPU produced it.
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:5173/';
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage();
try {
  await page.goto(url, { timeout: 8000 });
} catch {
  await page.goto('about:blank');
}
const info = await page.evaluate(async () => {
  if (!('gpu' in navigator)) return { error: 'no navigator.gpu', secure: window.isSecureContext };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { error: 'no adapter', secure: window.isSecureContext };
  const i = adapter.info;
  return { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description,
    secure: window.isSecureContext };
});
console.log(JSON.stringify({ chrome: browser.version(), url: page.url(), ...info }));
await browser.close();
