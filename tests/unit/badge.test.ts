// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { mountBadge } from '../../src/ui/badge';
import { installTooltips } from '../../src/ui/tooltip';
import type { Backend } from '../../src/renderer/create';

const BACKENDS: Backend[] = ['webgpu', 'webgl2'];
const TIERS = [null, 'base', 'mid', 'high'];

describe('mountBadge', () => {
  it.each(BACKENDS.flatMap((backend) => TIERS.map((tier) => ({ backend, tier }))))(
    'renders $backend with tier $tier and the GPU tooltip',
    ({ backend, tier }) => {
      const root = document.createElement('div');
      mountBadge(root, { backend, tier, gpuName: 'Example GPU' });

      const badge = root.querySelector<HTMLElement>('.badge');
      const tierLabel = root.querySelector<HTMLElement>('.badge__tier');
      expect(root.children).toHaveLength(1);
      expect(badge?.getAttribute('role')).toBe('status');
      expect(root.querySelector('.badge__backend')?.textContent).toBe(backend.toUpperCase());
      expect(tierLabel?.textContent).toBe(tier ?? '');
      expect(tierLabel?.hidden).toBe(tier === null);
      expect(badge?.dataset.tooltip).toBe('Example GPU');
      expect(badge?.hasAttribute('title')).toBe(false);
    },
  );

  it('updates every tier after a pending first render without replacing the labels', () => {
    const root = document.createElement('div');
    const handle = mountBadge(root, { backend: 'webgpu', tier: null, gpuName: 'Example GPU' });
    const badge = root.querySelector('.badge');
    const backendLabel = root.querySelector('.badge__backend');
    const tierLabel = root.querySelector<HTMLElement>('.badge__tier');

    for (const tier of ['base', 'mid', 'high', 'mid', 'base', null]) {
      handle.update({ tier });
      expect(root.querySelector('.badge')).toBe(badge);
      expect(root.querySelector('.badge__backend')).toBe(backendLabel);
      expect(root.querySelector('.badge__tier')).toBe(tierLabel);
      expect(root.children).toHaveLength(1);
      expect(tierLabel?.textContent).toBe(tier ?? '');
      expect(tierLabel?.hidden).toBe(tier === null);
      expect(backendLabel?.textContent).toBe('WEBGPU');
    }
  });

  it('updates backend and GPU independently while preserving omitted state', () => {
    const root = document.createElement('div');
    const handle = mountBadge(root, { backend: 'webgpu', tier: 'high', gpuName: 'First GPU' });
    const badge = root.querySelector<HTMLElement>('.badge');
    const backendLabel = root.querySelector('.badge__backend');
    const tierLabel = root.querySelector<HTMLElement>('.badge__tier');

    handle.update({ backend: 'webgl2' });
    expect(backendLabel?.textContent).toBe('WEBGL2');
    expect(badge?.dataset.tooltip).toBe('First GPU');
    expect(tierLabel?.textContent).toBe('high');
    expect(tierLabel?.hidden).toBe(false);

    badge?.setAttribute('title', 'stale native tooltip');
    handle.update({ gpuName: 'Second GPU' });
    expect(badge?.dataset.tooltip).toBe('Second GPU');
    expect(badge?.hasAttribute('title')).toBe(false);
    expect(backendLabel?.textContent).toBe('WEBGL2');
    expect(tierLabel?.textContent).toBe('high');

    handle.update({ backend: 'webgpu', gpuName: '' });
    handle.update({});
    expect(backendLabel?.textContent).toBe('WEBGPU');
    expect(badge?.dataset.tooltip).toBe('');
    expect(tierLabel?.textContent).toBe('high');
    expect(root.querySelector('.badge')).toBe(badge);
    expect(root.querySelector('.badge__backend')).toBe(backendLabel);
    expect(root.querySelector('.badge__tier')).toBe(tierLabel);
  });

  // The GPU name is only in the tooltip, so a keyboard visitor needs the badge on the tab order
  // (S18, the Y16 review's R8): it is a tab stop and the page tooltip opens on focus-visible
  // focus, like on every other tooltip anchor.
  it('is reachable by Tab and its GPU tooltip opens from the keyboard', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const tooltips = installTooltips(root);
    mountBadge(root, { backend: 'webgpu', tier: 'high', gpuName: 'Example GPU' });
    const badge = root.querySelector<HTMLElement>('.badge');
    expect(badge, 'the badge is mounted').not.toBeNull();
    expect(badge?.tabIndex, 'the badge is a tab stop').toBe(0);

    // Focus as a keyboard user gives it: jsdom has no input modality, so the element answers
    // :focus-visible the way a browser answers it after Tab.
    const matches = badge!.matches.bind(badge!);
    Object.defineProperty(badge!, 'matches', {
      configurable: true,
      value: (selector: string): boolean => (selector === ':focus-visible' ? true : matches(selector)),
    });
    badge!.focus();

    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');
    expect(tooltip?.hidden, 'the GPU tooltip opens from keyboard focus').toBe(false);
    expect(tooltip?.textContent).toBe('Example GPU');
    expect(badge?.getAttribute('aria-describedby')).toBe('a11y-tooltip');

    badge!.blur();
    expect(tooltip?.hidden).toBe(true);
    expect(badge?.hasAttribute('aria-describedby')).toBe(false);

    tooltips.dispose();
    root.remove();
  });
});
