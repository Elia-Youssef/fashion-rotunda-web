import { readFileSync } from 'node:fs';

import type { Color } from './contrast';

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Reads the simple, single-selector rules and colour tokens used by contrast contracts. */
export function readStylesheet(path: string, tokenPath = path) {
  const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const css = stripComments(readFileSync(path, 'utf8'));
  const tokenCss = tokenPath === path ? css : stripComments(readFileSync(tokenPath, 'utf8'));
  const tokens = new Map(
    [...tokenCss.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)]
      .map((match) => [match[1], match[2].trim()]),
  );

  function declaration(selector: string, property: string): string | undefined {
    const rule = css.match(new RegExp(`^${escapePattern(selector)}\\s*\\{([^}]*)\\}`, 'm'))?.[1];
    return rule?.match(new RegExp(`(?:^|;)\\s*${escapePattern(property)}:\\s*([^;]+);`))?.[1].trim();
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

  return { tokens, declaration, color };
}
