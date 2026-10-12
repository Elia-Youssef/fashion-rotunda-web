import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { contrast, over } from '../support/contrast';
import type { Color } from '../support/contrast';

const tokensCss = readFileSync('src/styles.css', 'utf8');
const lobbyCss = readFileSync('src/ui/entry-lobby.css', 'utf8');
const tokens = new Map([...tokensCss.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)]
  .map((match) => [match[1], match[2].trim()]));

function declaration(selector: string, property: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = lobbyCss.match(new RegExp(`^${escaped} \\{([^}]+)\\}`, 'm'))?.[1];
  const value = rule?.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`))?.[1];
  if (!value) throw new Error(`Missing ${property} on ${selector}`);
  return value.trim();
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

describe('lobby contrast accessibility contract', () => {
  it('composites translucent surfaces without rounding channels', () => {
    expect(over([255, 255, 255, 0.5], [0, 0, 0, 1])).toEqual([127.5, 127.5, 127.5, 1]);
    expect(contrast([255, 255, 255, 0], [0, 0, 0, 1])).toBe(1);
  });

  const minimumTextContrast = 4.5;
  for (const [endpoint, poster] of [
    ['black', [0, 0, 0, 1]], ['white', [255, 255, 255, 1]],
  ] as const) {
    it.each(['telemetry', 'desc', 'eyebrow'])(
      `%s text reaches AA over the ${endpoint} poster endpoint`, (role) => {
        const veil = color(declaration('.entry-lobby__scrim', 'background-color'));
        veil[3] *= Number(declaration('.entry-lobby__scrim', 'opacity'));
        const card = over(color(declaration('.entry-lobby__card', 'background')), over(veil, [...poster]));
        const text = color(declaration(`.entry-lobby__${role}`, 'color'));
        expect(contrast(text, card)).toBeGreaterThanOrEqual(minimumTextContrast);
      },
    );
  }
});
