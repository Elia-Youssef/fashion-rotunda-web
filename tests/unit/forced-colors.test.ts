// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve('src/ui/forced-colors.css'), 'utf8');
const style = document.createElement('style');
style.textContent = css;
document.head.append(style);
const sheet = style.sheet!;

function declarations(selector: string): CSSStyleDeclaration {
  const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
  for (const outer of sheet.cssRules) {
    if (!(outer instanceof CSSMediaRule)) continue;
    for (const rule of outer.cssRules) {
      if (rule instanceof CSSStyleRule && (
        normalize(rule.selectorText) === normalize(selector) ||
        rule.selectorText.split(',').some((part) => part.trim() === selector)
      )) {
        return rule.style;
      }
    }
  }
  throw new Error(`Missing rule: ${selector}`);
}

describe('forced colours presentation', () => {
  it('contains only rules gated to forced colours active', () => {
    expect(sheet.cssRules.length).toBeGreaterThan(0);
    for (const rule of sheet.cssRules) {
      expect(rule).toBeInstanceOf(CSSMediaRule);
      const media = rule as CSSMediaRule;
      expect(media.conditionText).toBe('(forced-colors: active)');
      expect(media.cssRules.length).toBeGreaterThan(0);
      for (const child of media.cssRules) expect(child).toBeInstanceOf(CSSStyleRule);
    }
  });

  it('imports the stylesheet exactly once from the composition root', () => {
    const main = readFileSync(resolve('src/main.ts'), 'utf8');
    expect(main.match(/import\s+['"]\.\/ui\/forced-colors\.css['"];?/g)).toHaveLength(1);
  });

  it.each([
    ".catalog-strip__button[aria-current='true']",
    ".product-card__swatch[aria-checked='true']",
    ".product-card__action[aria-pressed='true']",
    ".product-card__action[aria-expanded='true']",
    ".archviz-mode-button[aria-pressed='true']",
  ])('retains a geometric state indicator and independent focus outline for %s', (selector) => {
    const border = declarations(selector).getPropertyValue('border');
    expect(border).toMatch(/calc\(2\s*\*\s*var\(--focus-ring\)\)\s+double\s+Highlight/i);
    expect(declarations(selector).getPropertyValue('outline')).toBe('');
  });

  it('places every visible lobby state on an opaque system canvas', () => {
    const rule = declarations(
      ".entry-lobby:is([data-state='idle'], [data-state='loading'], [data-state='ready-hidden'],\n" +
      "    [data-state='error']) .entry-lobby__scrim",
    );
    expect(rule.getPropertyValue('background').toLowerCase()).toBe('canvas');
    expect(rule.getPropertyValue('opacity')).toBe('1');
    expect(css).not.toMatch(/data-state=['"](?:cover-to-black|black-hold|revealing|revealed)['"]/);
  });

  it.each(['::-webkit-progress-value', '::-moz-progress-bar'])(
    'gives %s a solid system fill that survives colour adjustment', (pseudo) => {
      const rule = declarations(`.entry-lobby__progress-bar${pseudo}`);
      expect(rule.getPropertyValue('background').toLowerCase()).toBe('canvastext');
      expect(rule.getPropertyValue('forced-color-adjust')).toBe('none');
    },
  );

  it('backs the scene header title with a system canvas', () => {
    const rule = declarations('#shell-header h1');
    expect(rule.getPropertyValue('background').toLowerCase()).toBe('canvas');
    expect(rule.getPropertyValue('color').toLowerCase()).toBe('canvastext');
  });
});
