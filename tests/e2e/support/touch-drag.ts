import type { Locator, Page } from '@playwright/test';

/** Sends two real touch contacts through Chromium's input pipeline, preserving their spread. */
export async function dragTwoFingers(page: Page, canvas: Locator, deltaY: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('the canvas has no box for a touch drag');
  const client = await page.context().newCDPSession(page);
  const centerX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  // A 120 px spread leaves both contacts inside the canvas at desktop and phone widths.
  const halfSpread = 60;
  // Several moves exercise the pointer stream rather than a single synthetic DOM event.
  const steps = 8;
  const contacts = (dy: number) => [
    { id: 1, x: centerX - halfSpread, y: startY + dy },
    { id: 2, x: centerX + halfSpread, y: startY + dy },
  ];
  let started = false;
  try {
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: contacts(0) });
    started = true;
    for (let step = 1; step <= steps; step += 1) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: contacts(deltaY * step / steps),
      });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    started = false;
  } finally {
    try {
      if (started) await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    } finally {
      try {
        await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      } finally {
        await client.detach();
      }
    }
  }
}
