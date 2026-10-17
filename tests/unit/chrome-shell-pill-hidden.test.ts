// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function displayRules(path: string): { selector: string; value: string; important: boolean }[] {
  const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match) => {
    const display = /(?:^|;)\s*display:\s*([\w-]+)\s*(!important)?\s*(?:;|$)/.exec(match[2]);
    return display
      ? match[1].split(',').map((selector) => ({
          selector: selector.trim(),
          value: display[1],
          important: Boolean(display[2]),
        }))
      : [];
  });
}

// These selectors contain only IDs, classes and attributes, with no type or pseudo selectors.
function specificity(selector: string): number[] {
  const tokens = selector.match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) ?? [];
  expect(selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g, '').trim()).toBe('');
  return [
    tokens.filter((token) => token.startsWith('#')).length,
    tokens.filter((token) => !token.startsWith('#')).length,
    0,
  ];
}

describe('hidden Look pill display contract', () => {
  it('keeps the hidden guard above both inline-flex layout rules in the cascade', () => {
    const shellRules = displayRules('src/ui/shell.css');
    const layoutRules = displayRules('src/styles.css');
    const guard = shellRules.find((rule) => rule.selector === '.shell-pill--look[hidden]');
    expect(guard, 'a Look pill display rule keyed on [hidden]').toBeDefined();
    if (!guard) throw new Error('Missing hidden Look pill guard');
    expect(guard.value).toBe('none');

    const pill = document.createElement('button');
    pill.className = 'shell-pill shell-pill--look';
    pill.hidden = true;
    expect(pill.matches(guard.selector)).toBe(true);
    pill.hidden = false;
    expect(pill.matches(guard.selector)).toBe(false);

    const base = shellRules.find((rule) => rule.selector === '.shell-pill');
    const landscape = layoutRules.find((rule) => rule.selector === '#shell-stage .shell-pill--look');
    expect(base, 'the base pill display rule').toBeDefined();
    expect(landscape, 'the short-landscape pill display rule').toBeDefined();
    if (!base || !landscape) throw new Error('Missing Look pill layout rule');
    expect(specificity(guard.selector)).toEqual([0, 2, 0]);
    expect(specificity(base.selector)).toEqual([0, 1, 0]);
    expect(specificity(landscape.selector)).toEqual([1, 1, 0]);
    expect(guard.important, 'the guard must overcome the landscape ID specificity').toBe(true);

    for (const rule of [base, landscape]) {
      expect(rule.value).toBe('inline-flex');
      const guardRank = [Number(guard.important), ...specificity(guard.selector)];
      const layoutRank = [Number(rule.important), ...specificity(rule.selector)];
      const decidingIndex = guardRank.findIndex((value, index) => value !== layoutRank[index]);
      expect(decidingIndex, 'the guard must win without relying on stylesheet order').toBeGreaterThanOrEqual(0);
      expect(guardRank[decidingIndex], `hidden guard outranks ${rule.selector}`).toBeGreaterThan(
        layoutRank[decidingIndex],
      );
    }
  });
});