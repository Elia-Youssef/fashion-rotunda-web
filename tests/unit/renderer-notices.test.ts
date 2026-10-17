// @vitest-environment jsdom
// Structure, not pixels: the tests assert the notice markup and the click wiring, never the
// poster image itself.

import { describe, expect, it, vi } from 'vitest';

import { DEVICE_LOST_MESSAGE, showLossNotice, showPoster } from '../../src/renderer/notices';
import type { DeviceLostInfo } from '../../src/renderer/create';

describe('showPoster', () => {
  it('replaces the root with the image, the message and the credit', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span>old content</span>';

    showPoster(root, { imageUrl: '/poster/hero.jpg', message: 'needs a gpu', credit: 'the studio' });

    const image = root.querySelector('img');
    expect(root.children).toHaveLength(3);
    expect(image?.getAttribute('src')).toBe('/poster/hero.jpg');
    expect(image?.getAttribute('alt')).toBe('needs a gpu');
    expect(root.querySelector('p')?.textContent).toBe('needs a gpu');
    expect(root.querySelector('small')?.textContent).toBe('the studio');
    expect(root.querySelector('span')).toBeNull();
  });

  it('does not duplicate when called twice', () => {
    const root = document.createElement('div');
    const options = { imageUrl: '/poster/hero.jpg', message: 'needs a gpu', credit: 'the studio' };

    showPoster(root, options);
    showPoster(root, options);

    expect(root.querySelectorAll('img')).toHaveLength(1);
    expect(root.children).toHaveLength(3);
  });

  it('addresses every poster part with its stylesheet class, in order', () => {
    const root = document.createElement('div');
    showPoster(root, { imageUrl: '/poster/hero.jpg', message: 'needs a gpu', credit: 'the studio' });

    const [image, message, credit] = root.children;
    expect(image?.tagName).toBe('IMG');
    expect(image?.className).toBe('poster__image');
    expect(message?.className).toBe('poster__message');
    expect(credit?.className).toBe('poster__credit');
  });
});

describe('showLossNotice', () => {
  it('appends one alert that explains the loss in plain words with a reload button', () => {
    const root = document.createElement('div');
    showLossNotice(root, { backend: 'webgl2', reason: 'unknown', message: 'context lost' }, vi.fn());

    const alert = root.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.querySelector('.loss-notice__title')?.textContent).toBe('The showroom paused');
    expect(alert?.querySelector('.loss-notice__text')?.textContent).toBe(
      `${DEVICE_LOST_MESSAGE} If this keeps happening, close other apps or tabs and try again.`,
    );
    expect(DEVICE_LOST_MESSAGE).toBe("Your device's graphics restarted. Reload to continue where you left off.");
    expect(alert?.querySelector('button')?.textContent).toBe('Reload');
  });

  it('keeps the reason and the renderer message behind a closed Details toggle', () => {
    const root = document.createElement('div');
    showLossNotice(root, { backend: 'webgl2', reason: 'unknown', message: 'context lost' }, vi.fn());

    const details = root.querySelector<HTMLDetailsElement>('[role="alert"] details.loss-notice__details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Details');
    expect(details?.querySelector('.loss-notice__reason')?.textContent).toBe('Reason: unknown');
    expect(details?.querySelector('.loss-notice__message')?.textContent).toBe('context lost');
    // The plain-words text and the button come first; the technical lines live only in the toggle.
    const alert = root.querySelector('[role="alert"]')!;
    expect([...alert.children].map((child) => child.className)).toEqual([
      'loss-notice__title',
      'loss-notice__text',
      'loss-notice__reload',
      'loss-notice__details',
    ]);
  });

  it('calls onReload once per click', () => {
    const root = document.createElement('div');
    const onReload = vi.fn();
    showLossNotice(root, { backend: 'webgpu', reason: 'device-collision', message: 'boom' }, onReload);

    const button = root.querySelector<HTMLButtonElement>('[role="alert"] button');
    button?.click();
    expect(onReload).toHaveBeenCalledTimes(1);
    button?.click();
    expect(onReload).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate when called twice', () => {
    const root = document.createElement('div');
    const info: DeviceLostInfo = { backend: 'webgl2', reason: 'unknown', message: 'context lost' };

    showLossNotice(root, info, vi.fn());
    showLossNotice(root, info, vi.fn());

    expect(root.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(root.querySelectorAll('button')).toHaveLength(1);
  });

  it('renders the exact title, reason line and message text', () => {
    const root = document.createElement('div');
    showLossNotice(root, { backend: 'webgpu', reason: 'device-collision', message: 'boom' }, vi.fn());

    expect(root.querySelector('.loss-notice__title')?.textContent).toBe('The showroom paused');
    expect(root.querySelector('.loss-notice__reason')?.textContent).toBe('Reason: device-collision');
    expect(root.querySelector('.loss-notice__message')?.textContent).toBe('boom');
  });
});
