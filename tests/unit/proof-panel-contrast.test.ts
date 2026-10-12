import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { contrast, over } from '../support/contrast';
import type { Color } from '../support/contrast';

const panelCss = readFileSync('src/proof/panel.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tokensCss = readFileSync('src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = new Map(
  [...tokensCss.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((match) => [match[1], match[2].trim()]),
);

// White is the brightest scene endpoint; no scene pixel can lighten the surface further.
const WHITE_BACKDROP: Color = [255, 255, 255, 1];
const TRANSPARENT: Color = [0, 0, 0, 0];
const MINIMUM_TEXT_CONTRAST = 4.5;

function declaration(selector: string, property: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = panelCss.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1];
  return rule?.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`))?.[1].trim();
}

function color(value: string): Color {
  const reference = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (reference) {
    const token = tokens.get(reference);
    if (!token) throw new Error(`Missing color token ${reference}`);
    return color(token);
  }
  if (/^#[\da-f]{6}$/i.test(value)) {
    return [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16)).concat(1) as Color;
  }
  const rgb = value.match(/^rgba?\((.+)\)$/)?.[1];
  if (!rgb) throw new Error(`Unsupported color ${value}`);
  const channels = rgb.split(/[\s,/]+/).filter(Boolean).map(Number);
  return [...channels.slice(0, 3), channels[3] ?? 1] as Color;
}

function surface(selector: string): Color {
  const background = declaration(selector, 'background');
  return background ? color(background) : [...TRANSPARENT];
}

function text(selector: string): Color {
  const value = declaration(selector, 'color') ?? declaration('.proof-panel', 'color');
  if (!value) throw new Error(`Missing text color for ${selector}`);
  return color(value);
}

describe('proof panel contrast over a white scene', () => {
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
    const fill = surface(button);
    fill[3] *= opacity;
    const background = over(fill, panel);
    const foreground = declaration(selector, 'color') ? text(selector) : text(button);
    foreground[3] *= opacity;
    const ratio = contrast(foreground, background);
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
