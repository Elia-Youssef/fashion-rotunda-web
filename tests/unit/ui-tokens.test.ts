import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The token contract: every component stylesheet draws its values from the :root block in
// src/styles.css and carries no literal of its own. Stylesheets outside src/ui (the proof
// panel, the camera controls) are scanned by the same rule.
//
// What counts as a literal, per the token rules: a hex colour, an rgb(/hsl( colour function, or a
// number with a px, rem, ms or s unit. What is allowed anywhere: bare 0; 1px (borders and the
// visually-hidden clip pattern both live on it, with an optional minus); percentages and every
// unit the token sheet does not own (em, vw, dvh, fr) and unitless numbers (opacity, weights,
// line heights, grid lines), which are either ratios or content-relative, not design tokens.
//
// Media query preludes are exempt by the same rule the CSS spec imposes: var() cannot appear in
// a media query, so the 768px/1200px breakpoints are the one place a number must stay literal.
// The numbers are pinned to the shell's BREAKPOINTS by tests/unit/chrome-shell-breakpoints.test.ts instead.

/** The folders under src that hold component stylesheets; each one is scanned in full. */
const COMPONENT_DIRS = ['ui', 'proof', 'camera'] as const;
const PAGE_SHEET = join(process.cwd(), 'src', 'styles.css');

interface Sheet {
  /** Path relative to src, and the key in the frozen-hash map. */
  readonly id: string;
  readonly path: string;
}

const HEX_COLOR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])/g;
const COLOR_FUNCTION = /(?:rgba?|hsla?)\(/g;
const BANNED_UNIT = /-?\d+(?:\.\d+)?(?:px|rem|ms|s)\b/g;

// These component stylesheets carry literals of their own (the notes on each entry say why).
// Pin their complete bytes instead of broadly exempting individual literals: a frozen sheet
// cannot change at all, so it can never weaken the token contract for an editable stylesheet.
const FROZEN_SHEET_HASHES: Readonly<Record<string, string>> = {
  // 2026-09-23: re-pinned after the client asked for every look to show in the desktop rail; the
  // desktop thumbnails now read their size from the rail's --rail-thumb token instead of 48px.
  // 2026-10-09: re-pinned after the focus ring of the horizontal band's last thumbnail was cut at
  // the scroll edge; below 1200px the last item now carries the ring's extent as end padding and
  // each thumbnail a matching scroll margin.
  'ui/catalog-strip.css': '61cb0e0985cc9b54e333d4671cd389981ac4e05eada7c03aa1934d1e813fe02e',
  // 2026-10-12: the Source link uses the existing muted text and focus tokens.
  // 2026-10-17: the hidden swatch selector wins by specificity without an important declaration.
  'ui/product-card.css': '89d51030780bce0a606a3c1dacbc5738e8659b886ed499317fcbae310bb2a1fd',
  'ui/share.css': 'dc7722407941d032ebab9b78b426eae29ccb5e083fc215046956042c7a104cca',
  // 2026-10-14: the panel's three exact matches became the --border, --text-muted and --text
  // tokens; the literals left in it are near misses that share no token value, so the sheet
  // freezes at its tokenised bytes and a reintroduced literal fails the hash.
  'proof/panel.css': '10a5eba8b2f4f27464da307d5ddb9bc194f2dd26f530974a434854f82e7dcc16',
  // Fixed-size touch controls with translucent fills, white borders and shadows of their own;
  // no token matches those values. Frozen bytes keep them from drifting.
  // 2026-10-17: the hidden joystick selector wins by specificity without an important declaration.
  'camera/joystick.css': 'eb66d99a8c508f6e83ef35aba0f12ffa7c771dc7c32d0e2ad7379dc876ee9609',
  // 2026-10-15: reserve all Walk labels through intrinsic layout without adding
  // colour, font or length literals; freeze the resulting layout rules too.
  // 2026-10-16: the notice box rule also styles the failed look-switch notice (.look-status),
  // selectors only, no new literal.
  'camera/mode-switch.css': '44e3ecc5bd5bb80af814e03ac6cde840e0ef1a6a0f47d46f1d10dafb1e773c5f',
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

function componentSheets(): Sheet[] {
  return COMPONENT_DIRS.flatMap((dir) =>
    readdirSync(join(process.cwd(), 'src', dir))
      .filter((name) => name.endsWith('.css'))
      .sort()
      .map((name) => ({ id: `${dir}/${name}`, path: join(process.cwd(), 'src', dir, name) })),
  ).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('the token contract on the component stylesheets', () => {
  it('scans every component stylesheet on disk in the three folders', () => {
    const ids = componentSheets().map((sheet) => sheet.id);
    expect(ids.length).toBeGreaterThan(10);
    expect(ids).toContain('ui/shell.css');
    expect(ids).toContain('proof/panel.css');
    expect(ids).toContain('camera/joystick.css');
    expect(ids).toContain('camera/mode-switch.css');
  });

  for (const sheet of componentSheets()) {
    const frozenHash = FROZEN_SHEET_HASHES[sheet.id];
    if (frozenHash !== undefined) {
      it(`${sheet.id} remains byte-identical frozen CSS`, () => {
        const css = readFileSync(sheet.path, 'utf8');
        expect(sha256(css), `${sheet.id} keeps its approved bytes`).toBe(frozenHash);
      });
    } else {
      it(`${sheet.id} carries no literal outside the token sheet`, () => {
        const css = stripComments(readFileSync(sheet.path, 'utf8'));
        expect(literalsIn(css), `${sheet.id} must use var(--...) values only`).toEqual([]);
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
    // A fallback does not exempt a name: var(--x, fallback) still reads --x, so every sheet
    // joins this check, the camera sheets' fallback-only references included.
    const sheets = [
      stripRootBlocks(pageCss),
      ...componentSheets().map((sheet) => stripComments(readFileSync(sheet.path, 'utf8'))),
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
    // The duration tokens come from the sheet itself, not a hand list here: every --dur-*
    // name the :root blocks define must collapse, so adding or retiring a duration token
    // cannot leave this check stale.
    const durationTokens = new Set<string>();
    for (const rootBlock of rootBlocks(stripComments(css))) {
      for (const match of rootBlock.matchAll(/--(dur-[\w-]+)\s*:/g)) {
        durationTokens.add(match[1]);
      }
    }
    expect(durationTokens.size, 'the sheet defines duration tokens').toBeGreaterThan(0);
    for (const token of durationTokens) {
      expect(block, `${token} collapses to 0ms`).toContain(`--${token}: 0ms`);
    }
    // "In one place": no other reduced-motion block may redefine the tokens.
    const redefinitions = css.match(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?--dur-/g) ?? [];
    expect(redefinitions.length, 'exactly one block owns the reduced-motion durations').toBe(1);
  });
});
