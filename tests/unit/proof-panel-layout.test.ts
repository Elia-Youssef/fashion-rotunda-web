// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('reserves a separate full-width proof column and the height below the header in floating-card mode', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync('src/styles.css', 'utf8');
  document.head.appendChild(style);
  try {
    const rules = [...style.sheet!.cssRules];
    const media = rules.find(
      (rule) => rule instanceof CSSMediaRule &&
        rule.conditionText === '(min-width: 768px) and (min-height: 600px)',
    ) as CSSMediaRule | undefined;
    expect(media, 'floating-card mode has its own proof layout').toBeDefined();
    const declarations = (selector: string): CSSStyleDeclaration => {
      const rule = [...media!.cssRules].find(
        (entry) => entry instanceof CSSStyleRule && entry.selectorText === selector,
      ) as CSSStyleRule | undefined;
      expect(rule, selector).toBeDefined();
      return rule!.style;
    };
    const value = (selector: string, property: string): string => {
      const scoped = selector === 'footer' ? 'footer:has(.proof-panel)' :
        selector === '#shell-proof' ? 'footer:has(.proof-panel) #shell-proof' :
          'footer:has(.proof-panel) .proof-panel';
      return declarations(scoped).getPropertyValue(property).replace(/\s+/g, ' ').trim();
    };
    expect(value('footer', 'right')).toBe(
      'calc(var(--safe-area-right) + 2 * var(--space-4) + min(var(--card-width), 40vw))',
    );
    expect(value('footer', 'width')).toBe(
      'min( var(--card-width), calc(100vw - var(--safe-area-left) - var(--safe-area-right) - ' +
      '3 * var(--space-4) - min(var(--card-width), 40vw)) )',
    );
    expect(value('#shell-proof', 'flex-direction')).toBe('column-reverse');
    expect(value('footer .proof-panel', 'flex')).toBe('0 0 auto');
    expect(value('footer .proof-panel', 'width')).toBe('100%');
    expect(value('footer .proof-panel', 'max-height')).toBe(
      'calc( 100dvh - var(--header-height) - var(--safe-area-top) - var(--safe-area-bottom) - ' +
      'var(--space-4) - var(--control-height) - var(--space-2) - var(--space-1) )',
    );
    const tablet = rules.find(
      (rule) => rule instanceof CSSMediaRule && rule.conditionText === '(min-width: 768px)',
    ) as CSSMediaRule;
    const tabletValue = (selector: string, property: string): string => {
      const rule = [...tablet.cssRules].find(
        (entry) => entry instanceof CSSStyleRule && entry.selectorText === selector,
      ) as CSSStyleRule;
      return rule.style.getPropertyValue(property).replace(/\s+/g, ' ').trim();
    };
    expect(tabletValue('#shell-card', 'width')).toBe('min(var(--card-width), 40vw)');
    expect(tabletValue('#shell-card', 'right')).toBe('calc(var(--space-4) + var(--safe-area-right))');
    expect(tabletValue('footer', 'bottom')).toBe('calc(var(--space-1) + var(--safe-area-bottom))');
    for (const [selector, property, expected] of [
      ['#shell-proof', 'gap', 'var(--space-2)'],
      ['.badge', 'min-height', 'var(--control-height)'],
      ['footer .proof-panel__list', 'min-height', '0px'],
      ['footer .proof-panel__list', 'overflow-y', 'auto'],
    ]) {
      const rule = rules.find(
        (entry) => entry instanceof CSSStyleRule && entry.selectorText === selector,
      ) as CSSStyleRule;
      expect(rule.style.getPropertyValue(property)).toBe(expected);
    }

    // Check the interval bounds across the tablet/desktop split, root font sizes and safe insets.
    // The expressions above tie this algebra to the shipped declarations, not an independent mock.
    const root = rules.find(
      (rule) => rule instanceof CSSStyleRule && rule.selectorText === ':root',
    ) as CSSStyleRule;
    const rem = (token: string): number => {
      const raw = root.style.getPropertyValue(token).trim();
      expect(raw).toMatch(/^\d+(?:\.\d+)?rem$/);
      return parseFloat(raw);
    };
    for (const width of [768, 960, 1199, 1200, 1280, 1920, 3440]) {
      for (const height of [600, 720, 1080]) {
        for (const font of [16, 20, 24]) {
          for (const inset of [0, 24]) {
            const gap = rem('--space-4') * font;
            const cardWidth = Math.min(rem('--card-width') * font, width * 0.4);
            const cardLeft = width - inset - gap - cardWidth;
            const proofRight = width - inset - 2 * gap - cardWidth;
            const proofWidth = Math.min(
              rem('--card-width') * font, width - 2 * inset - 3 * gap - cardWidth,
            );
            expect(cardLeft - proofRight).toBeCloseTo(gap);
            expect(proofRight - proofWidth).toBeGreaterThanOrEqual(inset + gap);
            expect(proofWidth).toBeGreaterThan(0);
            const badge = rem('--control-height') * font;
            const stripGap = rem('--space-2') * font;
            const bottom = rem('--space-1') * font + inset;
            const header = rem('--header-height') * font + inset;
            const ceiling = height - header - inset - gap - badge - stripGap -
              rem('--space-1') * font;
            expect(height - bottom - badge - stripGap - ceiling).toBeCloseTo(header + gap);
          }
        }
      }
    }
  } finally {
    style.remove();
  }
});

it('keeps the ordinary footer and badge rules unchanged until a proof panel is mounted', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync('src/styles.css', 'utf8');
  const footer = document.createElement('footer');
  const strip = document.createElement('aside');
  strip.id = 'shell-proof';
  const badge = document.createElement('p');
  badge.className = 'badge';
  strip.appendChild(badge);
  footer.appendChild(strip);
  document.head.appendChild(style);
  document.body.appendChild(footer);
  try {
    const rules = [...style.sheet!.cssRules];
    const media = rules.find(
      (rule) => rule instanceof CSSMediaRule &&
        rule.conditionText === '(min-width: 768px) and (min-height: 600px)',
    ) as CSSMediaRule;
    const columnRules = [...media.cssRules] as CSSStyleRule[];
    const targets = [footer, strip, badge];
    const matching = (): string[] => columnRules.flatMap(
      (rule) => targets.filter((node) => node.matches(rule.selectorText)).map(() => rule.selectorText),
    );
    expect(matching(), 'normal mode must match no separate-column rule').toEqual([]);

    // Check the unchanged ordinary declarations instead of asking jsdom to lay out media queries.
    const base = rules.filter((rule) => rule instanceof CSSStyleRule) as CSSStyleRule[];
    const tablet = rules.find(
      (rule) => rule instanceof CSSMediaRule && rule.conditionText === '(min-width: 768px)',
    ) as CSSMediaRule;
    const tabletRules = [...tablet.cssRules].filter(
      (rule) => rule instanceof CSSStyleRule,
    ) as CSSStyleRule[];
    const ordinary = [...base, ...tabletRules];
    const finalValue = (node: Element, property: string): string => {
      let result = '';
      for (const rule of ordinary) {
        if (node.matches(rule.selectorText) && rule.style.getPropertyValue(property)) {
          result = rule.style.getPropertyValue(property).replace(/\s+/g, ' ').trim();
        }
      }
      return result;
    };
    expect(finalValue(footer, 'right')).toBe('calc(var(--space-3) + var(--safe-area-right))');
    expect(finalValue(footer, 'bottom')).toBe('calc(var(--space-1) + var(--safe-area-bottom))');
    expect(finalValue(footer, 'width')).toBe(
      'min( var(--card-width), calc(100vw - var(--safe-area-left) - var(--safe-area-right) - ' +
      '2 * var(--space-3)) )',
    );
    expect(finalValue(footer, 'z-index')).toBe('var(--z-chrome)');
    expect(finalValue(strip, 'flex-direction')).toBe('row-reverse');

    const panel = document.createElement('section');
    panel.className = 'proof-panel';
    strip.appendChild(panel);
    targets.push(panel);
    expect(matching(), 'proof mode matches all three separate-column rules').toEqual([
      'footer:has(.proof-panel)',
      'footer:has(.proof-panel) #shell-proof',
      'footer:has(.proof-panel) .proof-panel',
    ]);
    panel.remove();
    targets.pop();
    expect(matching(), 'removing the proof panel restores ordinary rule matching').toEqual([]);
  } finally {
    footer.remove();
    style.remove();
  }
});
