// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { mountBadge } from '../../src/ui/badge';
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
});
