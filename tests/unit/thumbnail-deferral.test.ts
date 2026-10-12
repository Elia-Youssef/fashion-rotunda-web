// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogLook } from '../../src/catalog/catalog';

const look: CatalogLook = {
  id: 'first', name: 'First look', description: 'Description', thumbnail: 'thumbs/first.jpg',
  file: 'looks/first.glb', variants: ['base'], defaultVariant: 'base', mannequinNode: 'mannequin',
};
const other = { ...look, id: 'other', name: 'Other look', thumbnail: 'thumbs/other.jpg' };
let dispose: (() => void) | undefined;

beforeEach(() => { vi.resetModules(); performance.clearMarks(); });
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

async function mount(kind: 'rail' | 'card') {
  const marks = await import('../../src/proof/marks');
  const root = document.createElement('div');
  document.body.append(root);
  const thumbnailUrl = (item: CatalogLook): string => `/content/${item.thumbnail}`;
  const handle = kind === 'rail'
    ? (await import('../../src/ui/catalog-strip')).mountCatalogStrip(root, {
      looks: [look, other], current: look.id, thumbnailUrl, onSelect: vi.fn(),
    })
    : (await import('../../src/ui/product-card')).mountProductCard(root, {
      look, variant: 'base', thumbnailUrl,
      actions: { rotate: vi.fn(), reset: vi.fn(), material: vi.fn() },
    });
  dispose = () => handle.dispose();
  return { root, handle, marks };
}

for (const kind of ['rail', 'card'] as const) {
  describe(`${kind} thumbnail deferral`, () => {
    it('keeps labels, selection and controls immediate, with no source until the scene mark', async () => {
      const { root, marks } = await mount(kind);
      const images = [...root.querySelectorAll('img')];
      expect(images.length).toBe(kind === 'rail' ? 2 : 1);
      expect(root.textContent).toContain(look.name);
      expect(root.querySelector('button')?.disabled).toBe(false);
      expect(root.querySelector(kind === 'rail' ? '[aria-current="true"]' : '[aria-checked="true"]'))
        .not.toBeNull();
      for (const image of images) expect(image.hasAttribute('src')).toBe(false);
      const nodes = [...root.querySelectorAll('*')];
      marks.markFirstFrame();
      expect(images[0].getAttribute('src')).toBe('/content/thumbs/first.jpg');
      if (kind === 'rail') expect(images[1].getAttribute('src')).toBe('/content/thumbs/other.jpg');
      expect([...root.querySelectorAll('*')]).toEqual(nodes);
    });

    it('assigns immediately when the first-frame mark already exists', async () => {
      const marks = await import('../../src/proof/marks');
      marks.markFirstFrame();
      const { root } = await mount(kind);
      expect(root.querySelector('img')?.getAttribute('src')).toBe('/content/thumbs/first.jpg');
    });

    it('cancels pending sources on teardown before the mark', async () => {
      const { root, handle, marks } = await mount(kind);
      const images = [...root.querySelectorAll('img')];
      handle.dispose();
      marks.markFirstFrame();
      for (const image of images) expect(image.hasAttribute('src')).toBe(false);
    });
  });
}

it('hydrates only the current card look after selection changes before the mark', async () => {
  const { root, handle, marks } = await mount('card');
  if (!('setLook' in handle)) throw new Error('expected card');
  handle.setLook(other, 'base');
  expect(root.textContent).toContain(other.name);
  expect(root.querySelector('img')?.hasAttribute('src')).toBe(false);
  marks.markFirstFrame();
  expect(root.querySelector('img')?.getAttribute('src')).toBe('/content/thumbs/other.jpg');
});

it('cancels a card thumbnail when the selection is cleared before the mark', async () => {
  const { root, handle, marks } = await mount('card');
  if (!('setLook' in handle)) throw new Error('expected card');
  handle.setLook(null, null);
  marks.markFirstFrame();
  expect(root.querySelector('img')?.hasAttribute('src')).toBe(false);
});
