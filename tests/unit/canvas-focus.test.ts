import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The canvas focus indicator. The canvas is a tab stop, but it spans
// the whole viewport, so its indicator must live in the shared focus policy in styles.css and
// carry its own treatment: inset into the canvas box so the viewport cannot clip it, two-tone
// so it reads over the bright marble floor and the dark walls alike, and declared with an
// outline because forced colours keep outlines (repainted in the system focus colour) while
// they drop box-shadows. jsdom cannot paint, so the test pins the rule the browser renders.

const stylesCss = readFileSync('src/styles.css', 'utf8');

function declaration(rule: string, property: string): string {
  const value = rule.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`))?.[1];
  expect(value, `the canvas focus rule declares ${property}`).toBeTruthy();
  return value!.trim().replace(/\s+/g, ' ');
}

describe('canvas focus policy', () => {
  const rule = (stylesCss.match(/^canvas:focus-visible\s*\{([^}]*)\}/m)?.[1] ?? '').replace(
    /\s+/g,
    ' ',
  );

  it('styles canvas:focus-visible in the shared policy sheet', () => {
    expect(rule, 'styles.css carries a canvas:focus-visible rule').not.toBe('');
  });

  it('keeps an outline so forced colours keep the indicator', () => {
    // Forced colours drop box-shadow and repaint outline colours, so the outline is the
    // indicator forced colours cannot take away and the box-shadow may only add to it.
    const outline = declaration(rule, 'outline');
    expect(outline).toContain('var(--focus-ring)');
    expect(outline).toContain('var(--focus)');
  });

  it('insets the ring into the canvas box so the viewport cannot clip it', () => {
    const offset = declaration(rule, 'outline-offset');
    expect(offset, 'the ring sits inside the box').toMatch(/^calc\(-/);
    expect(offset).toContain('var(--focus-ring)');
  });

  it('carries the second tone as an inset backing for bright scenes', () => {
    const shadow = declaration(rule, 'box-shadow');
    expect(shadow, 'the backing band is an inset shadow').toContain('inset');
    expect(shadow, 'the backing band is the dark contrast token').toContain(
      'var(--focus-contrast)',
    );
    expect(stylesCss, 'the contrast token is defined in the token sheet').toMatch(
      /^\s*--focus-contrast:\s*/m,
    );
  });
});
