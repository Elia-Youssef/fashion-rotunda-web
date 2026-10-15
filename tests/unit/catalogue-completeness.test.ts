// The catalogue completeness gate. It reads both shipped catalogue documents from disk and fails
// when a look lacks its GLB, its half-set GLB, its thumbnail, a non-empty description, a source
// link, or names a variant outside base, light, dark, or when any file the catalogues reference
// is missing from disk. A device plays exactly one set (src/main.ts picks full or half by tier
// and touch input), so every check runs once per set, at the base that set resolves from.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { CATALOG_VERSION, parseCatalog } from '../../src/catalog/catalog';
import type { Catalog } from '../../src/catalog/catalog';

const SHIPPED_CONTENT = fileURLToPath(new URL('../../public/content', import.meta.url));

/** The three mannequin swatches the product card offers; any other name has no swatch to show. */
const ALLOWED_VARIANTS: readonly string[] = ['base', 'light', 'dark'];

/** One content set: where its catalogue document lives and where its media resolves from. */
interface ContentSet {
  label: string;
  catalogPath: string;
  baseDir: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Look files and thumbnails resolve against the set's own base (src/scene/showroom.ts and
// src/ui/chrome.ts join them onto contentBase), and so do the set's rotunda and plinth
// (src/scene/showroom.ts loads both from contentBase). The environment is the one exception:
// both sets share the full set's copy, and src/main.ts builds it from the full content base.
function auditSet(set: ContentSet, catalog: Catalog, fullRoot: string, defects: string[]): void {
  for (const look of catalog.looks) {
    const where = `${set.label} look "${look.id}"`;
    if (look.sourceUrl === undefined) defects.push(`${where} has no source link`);
    if (look.thumbnail === null) {
      defects.push(`${where} has no thumbnail`);
    } else if (!existsSync(join(set.baseDir, look.thumbnail))) {
      defects.push(`${where} thumbnail ${look.thumbnail} is missing from disk`);
    }
    for (const variant of look.variants) {
      if (!ALLOWED_VARIANTS.includes(variant)) {
        defects.push(`${where} uses variant "${variant}" outside base, light, dark`);
      }
    }
    if (!existsSync(join(set.baseDir, look.file))) {
      defects.push(`${where} file ${look.file} is missing from disk`);
    }
  }
  for (const [field, reference] of [
    ['rotunda', catalog.rotunda],
    ['plinth', catalog.plinth],
  ] as const) {
    if (!existsSync(join(set.baseDir, reference.file))) {
      defects.push(`${set.label} ${field} file ${reference.file} is missing from disk`);
    }
  }
  if (!existsSync(join(fullRoot, catalog.environment.file))) {
    defects.push(`${set.label} environment file ${catalog.environment.file} is missing from disk`);
  }
}

/**
 * Lists every completeness defect in the content tree at `contentRoot`, empty when both sets are
 * complete. A document that fails to parse is one defect naming the offending field: the parser
 * owns the field contract (src/catalog/catalog.ts), so an empty description or name already stops
 * it there, and this audit owns what the parser deliberately leaves open or never sees: optional
 * fields the product requires, variant names, and file presence on disk.
 */
function contentDefects(contentRoot: string): string[] {
  const defects: string[] = [];
  const sets: ContentSet[] = [
    { label: 'full', catalogPath: join(contentRoot, 'catalog.json'), baseDir: contentRoot },
    {
      label: 'half',
      catalogPath: join(contentRoot, 'half', 'catalog.json'),
      baseDir: join(contentRoot, 'half'),
    },
  ];
  const parsed = new Map<string, Catalog>();
  for (const set of sets) {
    let catalog: Catalog;
    try {
      catalog = parseCatalog(JSON.parse(readFileSync(set.catalogPath, 'utf8')));
    } catch (error) {
      defects.push(`${set.label}: ${set.catalogPath} does not load: ${errorMessage(error)}`);
      continue;
    }
    parsed.set(set.label, catalog);
    auditSet(set, catalog, contentRoot, defects);
  }
  const full = parsed.get('full');
  const half = parsed.get('half');
  if (full !== undefined && half !== undefined) {
    const halfIds = new Set(half.looks.map((look) => look.id));
    const fullIds = new Set(full.looks.map((look) => look.id));
    for (const look of full.looks) {
      if (!halfIds.has(look.id)) {
        defects.push(`look "${look.id}" is missing from the half catalogue`);
      }
    }
    for (const look of half.looks) {
      if (!fullIds.has(look.id)) {
        defects.push(`the half catalogue lists look "${look.id}", which the full catalogue does not`);
      }
    }
  }
  return defects;
}

// The negative controls rebuild a minimal content tree in a temporary directory and break one
// thing at a time, so every check above is proven to fire. Fixture files are empty because
// existence on disk is all the gate reads.

function fixtureLook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fixture-look',
    name: 'Fixture Look',
    description: 'A fixture look with every field the completeness gate requires.',
    thumbnail: 'thumbs/fixture-look.jpg',
    file: 'looks/fixture-look.glb',
    variants: ['base', 'light', 'dark'],
    defaultVariant: 'base',
    mannequinNode: 'mannequin',
    sourceUrl: 'https://example.com/fixture-look',
    ...overrides,
  };
}

function fixtureCatalog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: CATALOG_VERSION,
    rotunda: { file: 'rotunda.glb' },
    plinth: { file: 'plinth.glb' },
    environment: { file: 'env/fixture-1k.hdr' },
    looks: [fixtureLook()],
    views: { proof: { position: [0, 1.7, 4.2], target: [0, 1, 0], fov: 40 } },
    ...overrides,
  };
}

const FIXTURE_FILES = [
  'rotunda.glb',
  'plinth.glb',
  'env/fixture-1k.hdr',
  'looks/fixture-look.glb',
  'thumbs/fixture-look.jpg',
  'half/rotunda.glb',
  'half/plinth.glb',
  'half/looks/fixture-look.glb',
  'half/thumbs/fixture-look.jpg',
];

interface FixtureOptions {
  full?: Record<string, unknown>;
  half?: Record<string, unknown>;
  /** Fixture files to leave out, for defects about files missing from disk. */
  omit?: string[];
}

let fixtureRoot: string | undefined;

function writeFixture(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'catalogue-completeness-'));
  fixtureRoot = root;
  mkdirSync(join(root, 'half'), { recursive: true });
  writeFileSync(join(root, 'catalog.json'), JSON.stringify(options.full ?? fixtureCatalog()));
  writeFileSync(join(root, 'half', 'catalog.json'), JSON.stringify(options.half ?? fixtureCatalog()));
  const omitted = new Set(options.omit ?? []);
  for (const file of FIXTURE_FILES) {
    if (omitted.has(file)) continue;
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  }
  return root;
}

afterEach(() => {
  if (fixtureRoot !== undefined) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

/** Asserts the tree at `root` produces exactly one defect per pattern, and nothing else. */
function expectDefects(root: string, patterns: RegExp[]): void {
  const defects = contentDefects(root);
  expect(defects).toHaveLength(patterns.length);
  for (const pattern of patterns) {
    expect(
      defects.some((defect) => pattern.test(defect)),
      `no defect matched ${pattern}; the audit reported:\n${defects.join('\n')}`,
    ).toBe(true);
  }
}

describe('shipped catalogue completeness', () => {
  it('finds no defect in public/content', () => {
    expect(contentDefects(SHIPPED_CONTENT)).toEqual([]);
  });
});

describe('catalogue completeness negative controls', () => {
  it('accepts a complete fixture tree', () => {
    expect(contentDefects(writeFixture())).toEqual([]);
  });

  it('fails when a look GLB is missing from the full set', () => {
    const root = writeFixture({ omit: ['looks/fixture-look.glb'] });
    expectDefects(root, [/full look "fixture-look" file looks\/fixture-look\.glb is missing from disk/]);
  });

  it('fails when a look GLB is missing from the half set', () => {
    const root = writeFixture({ omit: ['half/looks/fixture-look.glb'] });
    expectDefects(root, [/half look "fixture-look" file looks\/fixture-look\.glb is missing from disk/]);
  });

  it('fails when a look has no thumbnail field', () => {
    const root = writeFixture({ full: fixtureCatalog({ looks: [fixtureLook({ thumbnail: null })] }) });
    expectDefects(root, [/full look "fixture-look" has no thumbnail/]);
  });

  it('fails when a look thumbnail file is missing from disk', () => {
    const root = writeFixture({ omit: ['half/thumbs/fixture-look.jpg'] });
    expectDefects(root, [
      /half look "fixture-look" thumbnail thumbs\/fixture-look\.jpg is missing from disk/,
    ]);
  });

  it('fails on an empty look description, at the parser that owns the field', () => {
    const root = writeFixture({ full: fixtureCatalog({ looks: [fixtureLook({ description: '   ' })] }) });
    expectDefects(root, [
      /full: .* does not load: catalog: looks\[0\]\.description is not a non-empty string/,
    ]);
  });

  it('fails when a look has no source link', () => {
    const root = writeFixture({ full: fixtureCatalog({ looks: [fixtureLook({ sourceUrl: undefined })] }) });
    expectDefects(root, [/full look "fixture-look" has no source link/]);
  });

  it('fails when a look names a variant outside base, light, dark', () => {
    const root = writeFixture({
      half: fixtureCatalog({ looks: [fixtureLook({ variants: ['base', 'light', 'chrome'] })] }),
    });
    expectDefects(root, [/half look "fixture-look" uses variant "chrome" outside base, light, dark/]);
  });

  it('fails when the half catalogue does not list every look the full catalogue lists', () => {
    const root = writeFixture({
      half: fixtureCatalog({ looks: [fixtureLook({ id: 'elsewhere-look' })] }),
    });
    expectDefects(root, [
      /look "fixture-look" is missing from the half catalogue/,
      /the half catalogue lists look "elsewhere-look", which the full catalogue does not/,
    ]);
  });

  it('fails when a shared file a catalogue references is missing from disk', () => {
    const root = writeFixture({ omit: ['half/rotunda.glb'] });
    expectDefects(root, [/half rotunda file rotunda\.glb is missing from disk/]);
  });
});
