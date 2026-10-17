import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// jsdom cannot paint focus indicators, so pin the shared rule the browser renders.
const stylesCss = readFileSync('src/styles.css', 'utf8');
const rules = [...stylesCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
const sharedRule = rules.find(([, selectors]) => {
  const members = selectors!.split(',').map((selector) => selector.trim());
  return members.includes('button:focus-visible') && members.includes('.badge:focus-visible');
})?.[2] ?? '';

function declaration(property: string): string | undefined {
  return sharedRule.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`))?.[1]
    ?.trim().replace(/\s+/g, ' ');
}

describe('badge focus policy', () => {
  it('includes the badge in the shared native-control focus rule', () => {
    expect(sharedRule, 'the badge shares the native-control focus declarations').not.toBe('');
  });

  it('uses the shared outline tokens so forced colours keep the indicator', () => {
    expect(declaration('outline')).toBe('var(--focus-ring) solid var(--focus)');
  });

  it('uses the shared outline offset token', () => {
    expect(declaration('outline-offset')).toBe('var(--focus-offset)');
  });
});
