import { describe, expect, it } from 'vitest';

import { contrast, over } from '../support/contrast';
import type { Color } from '../support/contrast';
import { readStylesheet } from '../support/stylesheet';

const { declaration, color } = readStylesheet('src/proof/panel.css', 'src/styles.css');

// White is the brightest scene endpoint; no scene pixel can lighten the surface further.
const WHITE_BACKDROP: Color = [255, 255, 255, 1];
const TRANSPARENT: Color = [0, 0, 0, 0];
const MINIMUM_TEXT_CONTRAST = 4.5;

function surface(selector: string): Color {
  const background = declaration(selector, 'background');
  return background ? color(background) : [...TRANSPARENT];
}

function text(selector: string): Color {
  const value = declaration(selector, 'color') ?? declaration('.proof-panel', 'color');
  if (!value) throw new Error(`Missing text color for ${selector}`);
  return color(value);
}

function buttonPixels(foreground: Color, fill: Color, panel: Color, opacity: number) {
  // Compose content first, then apply the element opacity to the whole group over the panel.
  const fillPixel = over(fill, panel);
  const contentPixel = over(foreground, fillPixel);
  return {
    textPixel: over([contentPixel[0], contentPixel[1], contentPixel[2], opacity], panel),
    background: over([fillPixel[0], fillPixel[1], fillPixel[2], opacity], panel),
  };
}

describe('proof panel contrast over a white scene', () => {
  it('preserves alpha in comma and slash colour syntax', () => {
    expect(color('rgba(20, 40, 60, 0.5)')).toEqual([20, 40, 60, 0.5]);
    expect(color('rgb(20 40 60 / 0)')).toEqual([20, 40, 60, 0]);
    expect(color('rgb(20, 40, 60)')).toEqual([20, 40, 60, 1]);
  });

  it('composes text over its fill before fading the button group', () => {
    const pixels = buttonPixels([200, 200, 200, 0.5], [100, 100, 100, 1], [0, 0, 0, 1], 0.5);
    expect(pixels.textPixel).toEqual([75, 75, 75, 1]);
    expect(pixels.background).toEqual([50, 50, 50, 1]);
  });

  it.each(['term', 'desc', 'status'])('%s text reaches AA on the panel surface', (role) => {
    const panel = over(surface('.proof-panel'), WHITE_BACKDROP);
    const ratio = contrast(text(`.proof-panel__${role}`), panel);
    expect(ratio, `${role} contrast ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(MINIMUM_TEXT_CONTRAST);
  });

  it.each(['enabled', 'disabled'])('%s Measure text reaches AA on its composited surface', (state) => {
    const panel = over(surface('.proof-panel'), WHITE_BACKDROP);
    const button = '.proof-panel__measure';
    const selector = state === 'disabled' ? `${button}:disabled` : button;
    const opacity = Number(declaration(selector, 'opacity') ?? declaration(button, 'opacity') ?? 1);
    const foreground = declaration(selector, 'color') ? text(selector) : text(button);
    const { textPixel, background } = buttonPixels(foreground, surface(button), panel, opacity);
    const ratio = contrast(textPixel, background);
    expect(ratio, `${state} Measure contrast ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      MINIMUM_TEXT_CONTRAST,
    );
  });

  it('gives the disabled Measure button a text colour of its own', () => {
    const disabled = declaration('.proof-panel__measure:disabled', 'color');
    expect(disabled, 'the disabled state declares its own colour').toBeDefined();
    expect(disabled, 'the disabled colour differs from the enabled one').not.toBe(
      declaration('.proof-panel__measure', 'color'),
    );
  });
});
