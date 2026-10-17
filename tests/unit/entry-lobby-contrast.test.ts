import { describe, expect, it } from 'vitest';

import { contrast, over } from '../support/contrast';
import { readStylesheet } from '../support/stylesheet';

const sheet = readStylesheet('src/ui/entry-lobby.css', 'src/styles.css');
const { color } = sheet;

function declaration(selector: string, property: string): string {
  const value = sheet.declaration(selector, property);
  if (!value) throw new Error(`Missing ${property} on ${selector}`);
  return value;
}

describe('lobby contrast accessibility contract', () => {
  it('composites translucent surfaces without rounding channels', () => {
    expect(over([255, 255, 255, 0.5], [0, 0, 0, 1])).toEqual([127.5, 127.5, 127.5, 1]);
    expect(contrast([255, 255, 255, 0], [0, 0, 0, 1])).toBe(1);
  });

  const minimumTextContrast = 4.5;

  // The 2026-10-17 lobby header subtitle measurement sampled four viewports. The brightest
  // backdrop was rgb(41,42,42) at 1280x720. The header sits over the shipped poster through
  // the 0.72 veil, so the pure-white poster endpoint is not the backdrop the text encounters.
  // This is already composited; remeasure if the poster, veil or header layout changes.
  const brightestMeasuredHeaderBackdrop = [41, 42, 42, 1] as const;

  it.each(['title', 'subtitle'])('%s header text reaches AA over the measured poster backdrop', (role) => {
    const text = color(declaration(`.entry-lobby__${role}`, 'color'));
    expect(contrast(text, [...brightestMeasuredHeaderBackdrop])).toBeGreaterThanOrEqual(minimumTextContrast);
  });

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
