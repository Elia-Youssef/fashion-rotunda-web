import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { contrast, over } from '../support/contrast';

// Muted text over the glass chrome: the roles that sit directly on translucent surfaces with no
// opaque panel behind them carry --text-muted-glass, which must reach WCAG AA (4.5:1) against
// the brightest composited glass the scene paints behind them. The 2026-10-12 browser audit
// sampled the composited backdrop-filter result inside each role's box over the brightest rig
// and camera poses; the worst backdrop per role is pinned below.
// --text-muted stays on the opaque panels, where it passes, and the panel opacities are
// unchanged by this contract.

const stylesCss = readFileSync('src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const musicSwitchCss = readFileSync('src/ui/music-switch.css', 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const lightpanelCss = readFileSync('src/ui/lightpanel.css', 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

const GLASS_TOKEN = '--text-muted-glass';
const MINIMUM_TEXT_CONTRAST = 4.5;

const tokens = new Map(
  [...stylesCss.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((match) => [match[1], match[2].trim()]),
);

function declaration(css: string, selector: string, property: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1];
  const value = rule?.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`))?.[1];
  expect(value, `${selector} declares ${property}`).toBeTruthy();
  return value!.trim();
}

function tokenColor(name: string): [number, number, number] {
  const hex = tokens.get(name) ?? '';
  expect(hex, `styles.css defines ${name} as a hex colour`).toMatch(/^#[\da-f]{6}$/i);
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
}

describe('muted-on-glass text contrast', () => {
  it('composites translucent text before computing contrast', () => {
    expect(over([255, 255, 255, 0.5], [0, 0, 0, 1])).toEqual([127.5, 127.5, 127.5, 1]);
    expect(contrast([255, 255, 255, 0], [0, 0, 0, 1])).toBe(1);
  });

  const glassText = tokenColor(GLASS_TOKEN);

  // One row per audited role: the stylesheet that owns it, its selector, and the worst
  // composited glass backdrop measured behind it (sRGB, 2026-10-12 audit).
  const roles = [
    { sheet: stylesCss, file: 'src/styles.css', selector: '.badge__tier', backdrop: [64, 66, 67] },
    {
      sheet: musicSwitchCss,
      file: 'src/ui/music-switch.css',
      selector: ".music-switch[data-music='error']",
      backdrop: [66, 68, 70],
    },
    {
      sheet: lightpanelCss,
      file: 'src/ui/lightpanel.css',
      selector: '.lightpanel__guidance',
      backdrop: [54, 58, 62],
    },
  ] as const;

  it.each(roles)('$selector reads with the muted-on-glass token', ({ sheet, file, selector }) => {
    expect(declaration(sheet, selector, 'color'), `${file} ${selector} carries the token`).toBe(
      `var(${GLASS_TOKEN})`,
    );
  });

  it.each(roles)(
    '$selector keeps AA on its worst audited backdrop',
    ({ selector, backdrop }) => {
      const ratio = contrast([...glassText, 1], [...backdrop, 1]);
      expect(ratio, `${selector} on rgb(${backdrop.join(',')})`).toBeGreaterThanOrEqual(
        MINIMUM_TEXT_CONTRAST,
      );
    },
  );

  it('leaves --text-muted on the opaque-panel roles', () => {
    // The audit passed the opaque-panel roles with the shared muted tone; the glass token is an
    // addition, not a replacement, so the panel roles keep reading with --text-muted.
    expect(tokens.get('--text-muted')).toBe('#9aa2ab');
    expect(declaration(stylesCss, '.poster__credit', 'color')).toBe('var(--text-muted)');
  });
});
