// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTooltips, VIEWPORT_PADDING_PX } from '../../src/ui/tooltip';
import type { TooltipHandle } from '../../src/ui/tooltip';

// The tooltip's viewport contract (S18, the Y16 review's R8): the box wraps inside a
// viewport-bounded width instead of forcing one line, and updatePosition keeps the measured box
// inside that same inset rectangle on both axes, so the whole tooltip stays visible at a 320 px
// viewport and at 200 percent text. jsdom has no layout engine, so each scenario supplies the
// box the browser would measure for the wrapped text and asserts the clamped position.

const VIEWPORT = { width: 320, height: 568 };

let root: HTMLElement;
let handle: TooltipHandle | null = null;
let anchor: HTMLButtonElement;
let tooltip: HTMLElement;
// The --tooltip-x value the stylesheet saw each time the box was measured, first read first.
let measuredAt: string[];
const viewportStubs: Array<[string, PropertyDescriptor | undefined]> = [];

function installViewport(): void {
  for (const property of ['innerWidth', 'innerHeight'] as const) {
    viewportStubs.push([property, Object.getOwnPropertyDescriptor(window, property)]);
    Object.defineProperty(window, property, {
      configurable: true,
      value: property === 'innerWidth' ? VIEWPORT.width : VIEWPORT.height,
    });
  }
}

function uninstallViewport(): void {
  for (const [property, descriptor] of viewportStubs.reverse()) {
    if (descriptor !== undefined) {
      Object.defineProperty(window, property, descriptor);
    } else {
      delete (window as unknown as Record<string, unknown>)[property];
    }
  }
  viewportStubs.length = 0;
}

/** Gives the tooltip the box a browser measures for text wrapped at the stylesheet's max width. */
function measureBox(width: number, height: number): void {
  Object.defineProperty(tooltip, 'offsetWidth', {
    configurable: true,
    get: () => {
      measuredAt.push(tooltip.style.getPropertyValue('--tooltip-x'));
      return width;
    },
  });
  Object.defineProperty(tooltip, 'offsetHeight', { configurable: true, get: () => height });
}

function anchorBox(left: number, top: number, right: number, bottom: number): void {
  vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({ left, top, right, bottom }),
  });
}

function show(): void {
  anchor.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
  expect(tooltip.hidden, 'the tooltip is shown').toBe(false);
}

function position(): { x: number; y: number } {
  return {
    x: Number.parseFloat(tooltip.style.getPropertyValue('--tooltip-x')),
    y: Number.parseFloat(tooltip.style.getPropertyValue('--tooltip-y')),
  };
}

function expectInside(): void {
  const { x, y } = position();
  expect(x).toBeGreaterThanOrEqual(VIEWPORT_PADDING_PX);
  expect(y).toBeGreaterThanOrEqual(VIEWPORT_PADDING_PX);
  expect(x + tooltip.offsetWidth, 'the box clears the right edge').toBeLessThanOrEqual(
    VIEWPORT.width - VIEWPORT_PADDING_PX,
  );
  expect(y + tooltip.offsetHeight, 'the box clears the bottom edge').toBeLessThanOrEqual(
    VIEWPORT.height - VIEWPORT_PADDING_PX,
  );
}

beforeEach(() => {
  installViewport();
  measuredAt = [];
  root = document.createElement('div');
  document.body.appendChild(root);
  handle = installTooltips(root);
  tooltip = root.querySelector<HTMLElement>('.a11y-tooltip')!;
  anchor = document.createElement('button');
  anchor.type = 'button';
  anchor.dataset.tooltip = 'NVIDIA GeForce RTX 4090';
  root.appendChild(anchor);
});

afterEach(() => {
  handle?.dispose();
  handle = null;
  root.remove();
  uninstallViewport();
  vi.restoreAllMocks();
});

describe('tooltip wrap and viewport clamp', () => {
  it('wraps instead of forcing one line, inside the viewport-bounded max width', () => {
    const css = readFileSync('src/ui/tooltip.css', 'utf8');
    const rule = (css.match(/^\.a11y-tooltip\s*\{([^}]*)\}/m)?.[1] ?? '').replace(/\s+/g, ' ');
    expect(rule, 'the tooltip rule is on the sheet').not.toBe('');
    expect(rule).toContain('white-space: normal;');
    expect(rule).toContain('overflow-wrap: anywhere;');
    expect(rule).toContain('max-width: calc(100vw - 2 * var(--tooltip-viewport-inset));');
    expect(css, 'no rule forces one line again').not.toContain('nowrap');
  });

  it('measures against the same inset the stylesheet caps the width with', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    const declared = Number.parseInt(
      css.match(/--tooltip-viewport-inset:\s*(\d+)px/)?.[1] ?? '',
      10,
    );
    expect(declared).toBe(VIEWPORT_PADDING_PX);
  });

  it('keeps a wrapped unbroken string inside 320x568 on a centred top trigger', () => {
    // A driver string such as "NVIDIA GeForce RTX 4090" wraps at the stylesheet's max width:
    // 320 - 2 * 8 = 304 CSS px wide. The anchor sits high, so the box flips below it.
    anchorBox(120, 30, 160, 60);
    measureBox(304, 46);
    show();
    expectInside();
    expect(position()).toEqual({ x: 8, y: 66 });
  });

  it('keeps long prose inside 320x568 for a bottom-corner trigger', () => {
    // Long prose at 200 percent text wraps to a tall box beside a trigger in the corner the
    // badge and the light rows really occupy.
    anchorBox(200, 520, 316, 552);
    measureBox(186, 90);
    show();
    expectInside();
    expect(position()).toEqual({ x: 126, y: 424 });
  });

  it('clamps a box taller than the headroom on either side of its trigger', () => {
    // The worst case: an extreme wrap leaves less room than the box needs above and below the
    // anchor. The clamp pulls the box inside and covers its own anchor rather than the bottom
    // edge pushing glyphs off screen.
    anchorBox(120, 540, 160, 566);
    measureBox(304, 540);
    show();
    expectInside();
    expect(position().y).toBe(VIEWPORT.height - 540 - VIEWPORT_PADDING_PX);
  });

  it('measures the wrapped box only after parking it at the inset', () => {
    // A shrink-to-fit fixed box wraps into the space right of its current left edge, so the
    // box must sit at the inset while its width is measured; a measurement at the previous
    // position could return a narrower box than the clamped position shows.
    anchorBox(120, 30, 160, 60);
    measureBox(304, 46);
    show();
    expect(measuredAt, 'every measurement saw the parked inset').toEqual([
      `${VIEWPORT_PADDING_PX}px`,
    ]);
  });

  it('keeps the box inside when the trigger moves while the tooltip is open', () => {
    anchorBox(120, 30, 160, 60);
    measureBox(304, 46);
    show();
    anchorBox(4, 300, 44, 330);
    window.dispatchEvent(new Event('scroll'));
    expectInside();
    expect(position().x).toBe(VIEWPORT_PADDING_PX);
  });
});
