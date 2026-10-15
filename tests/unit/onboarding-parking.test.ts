// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountOnboarding } from '../../src/ui/onboarding';
import type { OnboardingHandle } from '../../src/ui/onboarding';

// The guide card is position: fixed with no width of its own and a max-width well above its
// prose, so the browser wraps it shrink-to-fit into the space right of its current left edge:
// measured further right, the same text reports a narrower box. positionNearAnchor must
// therefore park the card at the left inset before it reads offsetWidth, or a step measures
// where a shorter step left the card, clamps too far right on that narrow reading, and the card
// widens past the right safe inset at its new position. jsdom has no layout engine, so the
// offsetWidth stub models the wrap: it reads the card's current --onboarding-x and narrows as
// that left edge moves right, and the natural width follows the rendered prose so a shorter
// step leaves a narrower box. The scenario is the 844x390 landscape phone of the report.

const VIEWPORT = { width: 844, height: 390 };
/** The positioning code's margin; the safe-area insets are its only other terms. */
const MARGIN_PX = 16;
/** The stylesheet's fallback left edge: left: var(--onboarding-x, var(--space-4)). */
const FALLBACK_X_PX = 16;
/** Wrapping floor: the buttons row keeps the box at least this wide whatever inset is left. */
const MIN_CONTENT_PX = 120;
/** Natural one-line width per character of prose, above the floor for every step's text. */
const PX_PER_CHARACTER = 2;
const CARD_HEIGHT_PX = 120;

let root: HTMLElement;
let handle: OnboardingHandle | null = null;
let card: HTMLElement | null = null;
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

/** The width the browser wraps the card to at the left edge it currently sits at. */
function wrappedWidth(): number {
  const raw = card?.style.getPropertyValue('--onboarding-x') ?? '';
  const parsed = Number.parseFloat(raw);
  const left = Number.isFinite(parsed) ? parsed : FALLBACK_X_PX;
  const prose = card?.querySelector('.onboarding-card__text')?.textContent ?? '';
  const natural = MIN_CONTENT_PX + Math.round(prose.length * PX_PER_CHARACTER);
  // The stylesheet caps the box at --card-width (24rem), which 844 px of viewport never binds.
  return Math.min(natural, Math.max(MIN_CONTENT_PX, VIEWPORT.width - left));
}

/** Captures the card when present() appends it and stubs the box the browser would measure. */
function interceptCardAppend(): void {
  const originalAppend = root.appendChild.bind(root);
  vi.spyOn(root, 'appendChild').mockImplementation((node: Node) => {
    const appended = originalAppend(node);
    if (card === null && node instanceof HTMLElement && node.classList.contains('onboarding-card')) {
      card = node;
      Object.defineProperty(node, 'offsetWidth', {
        configurable: true,
        get: () => {
          measuredAt.push(node.style.getPropertyValue('--onboarding-x'));
          return wrappedWidth();
        },
      });
      Object.defineProperty(node, 'offsetHeight', {
        configurable: true,
        get: () => CARD_HEIGHT_PX,
      });
    }
    return appended;
  });
}

function anchorBox(el: HTMLElement, left: number, top: number, right: number, bottom: number): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
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

beforeEach(() => {
  installViewport();
  measuredAt = [];
  root = document.createElement('div');
  document.body.appendChild(root);

  const scene = document.createElement('canvas');
  scene.id = 'scene';
  const looks = document.createElement('nav');
  looks.id = 'looks';
  const lightToggle = document.createElement('button');
  lightToggle.id = 'shell-light-toggle';
  lightToggle.textContent = 'Light Control';
  document.body.append(scene, looks, lightToggle);

  // The anchors where the shell really places them at 844x390: a full-viewport scene, the looks
  // rail against the right edge and the Light Control launcher in the bottom-right corner.
  anchorBox(scene, 0, 0, VIEWPORT.width, VIEWPORT.height);
  anchorBox(looks, 700, 40, 830, 350);
  anchorBox(lightToggle, 760, 300, 830, 374);
});

afterEach(() => {
  handle?.dispose();
  handle = null;
  card = null;
  root.remove();
  document.querySelector('#scene')?.remove();
  document.querySelector('#looks')?.remove();
  document.querySelector('#shell-light-toggle')?.remove();
  uninstallViewport();
  vi.restoreAllMocks();
});

describe('onboarding guide parking', () => {
  it('measures each step parked at the left inset and keeps the card inside the right inset', () => {
    handle = mountOnboarding({
      root,
      storage: { getItem: () => null, setItem: () => undefined },
    });
    interceptCardAppend();

    handle.start();
    handle.complete('orbit');
    handle.complete('looks');

    // jsdom resolves neither env() nor custom properties, so the safe-area insets read 0 and
    // the left inset the code parks at is its own margin.
    expect(measuredAt, 'every measurement saw the card parked at the left inset').toEqual([
      `${MARGIN_PX}px`,
      `${MARGIN_PX}px`,
      `${MARGIN_PX}px`,
    ]);
    // Without the parking line the Looks step leaves the card at 614 px, the Lights step reads
    // a 230 px box there, clamps to 598 px and the card wraps to 246 px: 844 px, one margin
    // past the right safe inset of 828 px. Parked, the Lights step reads its full 276 px box
    // and clamps to 552 px, whose 276 px wrap ends exactly on the inset.
    const finalX = Number.parseFloat(card?.style.getPropertyValue('--onboarding-x') ?? '');
    expect(finalX + wrappedWidth(), 'the wrapped card clears the right safe inset')
      .toBeLessThanOrEqual(VIEWPORT.width - MARGIN_PX);
  });
});
