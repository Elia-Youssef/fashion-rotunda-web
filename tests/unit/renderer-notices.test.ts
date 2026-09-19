// @vitest-environment jsdom
// Structure, not pixels: the tests assert the notice markup and the click wiring, never the
// poster image itself.

import { describe, expect, it, vi } from 'vitest';

import { showLossNotice, showPoster } from '../../src/renderer/notices';
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
});

describe('showLossNotice', () => {
  it('appends one alert carrying the reason, the message and a reload button', () => {
    const root = document.createElement('div');
    showLossNotice(root, { backend: 'webgl2', reason: 'unknown', message: 'context lost' }, vi.fn());

    const alert = root.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('unknown');
    expect(alert?.textContent).toContain('context lost');
    expect(alert?.querySelector('button')?.textContent).toBe('Reload');
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
});
