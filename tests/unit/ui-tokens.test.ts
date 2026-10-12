import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The token contract: every component stylesheet draws its values from the :root block in
// src/styles.css and carries no literal of its own.
//
// What counts as a literal, per the token rules: a hex colour, an rgb(/hsl( colour function, or a
// number with a px, rem, ms or s unit. What is allowed anywhere: bare 0; 1px (borders and the
// visually-hidden clip pattern both live on it, with an optional minus); percentages and every
// unit the token sheet does not own (em, vw, dvh, fr) and unitless numbers (opacity, weights,
// line heights, grid lines), which are either ratios or content-relative, not design tokens.
//
// Media query preludes are exempt by the same rule the CSS spec imposes: var() cannot appear in
// a media query, so the 768px/1200px breakpoints are the one place a number must stay literal.
// The numbers are pinned to the shell's BREAKPOINTS by tests/unit/chrome-shell.test.ts instead.

const UI_DIR = join(process.cwd(), 'src', 'ui');
const PAGE_SHEET = join(process.cwd(), 'src', 'styles.css');

const HEX_COLOR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])/g;
const COLOR_FUNCTION = /(?:rgba?|hsla?)\(/g;
const BANNED_UNIT = /-?\d+(?:\.\d+)?(?:px|rem|ms|s)\b/g;

// These component stylesheets contain existing literals and are outside the token allowlist.
// Pin their complete bytes instead of broadly exempting individual literals: frozen stylesheets
// must not change or weaken the token contract for any editable stylesheet.
const FROZEN_PREDECESSOR_SHEET_HASHES: Readonly<Record<string, string>> = {
  // 2026-09-23: re-pinned after the client asked for every look to show in the desktop rail; the
  // desktop thumbnails now read their size from the rail's --rail-thumb token instead of 48px.
  // 2026-10-09: re-pinned after the focus ring of the horizontal band's last thumbnail was cut at
  // the scroll edge; below 1200px the last item now carries the ring's extent as end padding and
  // each thumbnail a matching scroll margin.
  'catalog-strip.css': '61cb0e0985cc9b54e333d4671cd389981ac4e05eada7c03aa1934d1e813fe02e',
  // 2026-10-12: the Source link uses the existing muted text and focus tokens.
  'product-card.css': '4586de02d5b823d001d9e0aa4d10e02056b992bc90e797bba52657d293613659',
  'share.css': 'dc7722407941d032ebab9b78b426eae29ccb5e083fc215046956042c7a104cca',
};

function stripComments(css: string): string {
  // The at-rule preludes go with the comments: a media query cannot read var(), so its
  // breakpoint numbers are exempt (see the note above). The block's contents stay.
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '{');
}

/** Removes every :root block with balanced braces, so token definitions are never scanned. */
function stripRootBlocks(css: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const start = css.indexOf(':root', cursor);
    if (start === -1) {
      return out + css.slice(cursor);
    }
    const open = css.indexOf('{', start);
    if (open === -1) {
      return out + css.slice(cursor);
    }
    out += css.slice(cursor, start);
    let depth = 1;
    let close = open + 1;
    while (close < css.length && depth > 0) {
      const char = css[close];
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      }
      close += 1;
    }
    cursor = close;
  }
}

/** Every :root block in the sheet, kept as text so the token names can be read back. */
function rootBlocks(css: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = css.indexOf(':root', cursor);
    if (start === -1) {
      return blocks;
    }
    const open = css.indexOf('{', start);
    let depth = 1;
    let close = open + 1;
    while (close < css.length && depth > 0) {
      const char = css[close];
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      }
      close += 1;
    }
    blocks.push(css.slice(open + 1, close - 1));
    cursor = close;
  }
}

function literalsIn(css: string): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(HEX_COLOR)) {
    found.push(`hex colour ${match[0]}`);
  }
  for (const match of css.matchAll(COLOR_FUNCTION)) {
    found.push(`colour function ${match[0]}`);
  }
  for (const match of css.matchAll(BANNED_UNIT)) {
    if (match[0] === '1px' || match[0] === '-1px') {
      continue;
    }
    found.push(`length or duration ${match[0]}`);
  }
  return found;
}

function componentSheets(): string[] {
  return readdirSync(UI_DIR)
    .filter((name) => name.endsWith('.css'))
    .sort();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('the token contract on the component stylesheets', () => {
  it('scans every src/ui stylesheet on disk, shell.css included', () => {
    const sheets = componentSheets();
    expect(sheets.length).toBeGreaterThan(5);
    expect(sheets).toContain('shell.css');
  });

  for (const sheet of componentSheets()) {
    const frozenHash = FROZEN_PREDECESSOR_SHEET_HASHES[sheet];
    if (frozenHash !== undefined) {
      it(`${sheet} remains byte-identical frozen CSS`, () => {
        const css = readFileSync(join(UI_DIR, sheet), 'utf8');
        expect(sha256(css), `${sheet} keeps its approved bytes`).toBe(frozenHash);
      });
    } else {
      it(`${sheet} carries no literal outside the token sheet`, () => {
        const css = stripComments(readFileSync(join(UI_DIR, sheet), 'utf8'));
        expect(literalsIn(css), `${sheet} must use var(--...) values only`).toEqual([]);
      });
    }
  }

  it('styles.css carries no literal outside its :root blocks', () => {
    const css = stripComments(readFileSync(PAGE_SHEET, 'utf8'));
    const found = literalsIn(stripRootBlocks(css));
    expect(found, 'the page sheet must use var(--...) values only').toEqual([]);
  });

  it('defines every token the stylesheets use', () => {
    const defined = new Set<string>();
    const pageCss = stripComments(readFileSync(PAGE_SHEET, 'utf8'));
    for (const block of rootBlocks(pageCss)) {
      for (const match of block.matchAll(/--([\w-]+)\s*:/g)) {
        defined.add(match[1]);
      }
    }
    // The tooltip and the onboarding card position themselves from JavaScript, which writes
    // these two pairs as inline styles; they are coordinates, not design tokens.
    const runtimePositioned = new Set(['tooltip-x', 'tooltip-y', 'onboarding-x', 'onboarding-y']);
    const used = new Set<string>();
    const sheets = [
      stripRootBlocks(pageCss),
      ...componentSheets().map((name) => stripComments(readFileSync(join(UI_DIR, name), 'utf8'))),
    ];
    for (const css of sheets) {
      for (const match of css.matchAll(/var\(--([\w-]+)/g)) {
        used.add(match[1]);
      }
    }
    const missing = [...used].filter((token) => !defined.has(token) && !runtimePositioned.has(token));
    expect(missing, 'every var() name is defined in a :root block').toEqual([]);
  });

  it('zeroes every duration token under prefers-reduced-motion, in one place', () => {
    // The raw sheet, not the stripped one: stripComments removes at-rule preludes, and this
    // check is exactly about the prelude and its block.
    const css = readFileSync(PAGE_SHEET, 'utf8');
    const blockAt = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(blockAt, 'the reduced-motion media block exists').toBeGreaterThanOrEqual(0);
    const blockEnd = css.indexOf('}', blockAt);
    const block = css.slice(blockAt, blockEnd);
    for (const token of ['--dur-fast', '--dur-base', '--dur-slow']) {
      expect(block, `${token} collapses to 0ms`).toContain(`${token}: 0ms`);
    }
    // "In one place": no other reduced-motion block may redefine the tokens.
    const redefinitions = css.match(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?--dur-/g) ?? [];
    expect(redefinitions.length, 'exactly one block owns the reduced-motion durations').toBe(1);
  });
});
