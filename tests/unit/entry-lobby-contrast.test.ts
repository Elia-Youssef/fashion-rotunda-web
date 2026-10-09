import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokensCss = readFileSync('src/styles.css', 'utf8');
const lobbyCss = readFileSync('src/ui/entry-lobby.css', 'utf8');
const tokens = new Map([...tokensCss.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)]
  .map((match) => [match[1], match[2].trim()]));
type Color = [number, number, number, number];

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

// Compose in sRGB without intermediate rounding, then linearize for WCAG relative luminance.
function over(foreground: Color, background: Color): Color {
  return foreground.slice(0, 3).map((channel, index) =>
    channel * foreground[3] + background[index] * (1 - foreground[3])).concat(1) as Color;
}

function luminance(rgb: Color): number {
  const channels = rgb.slice(0, 3).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: Color, background: Color): number {
  const text = luminance(over(foreground, background));
  const surface = luminance(background);
  return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
}

describe('lobby contrast accessibility contract', () => {
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
