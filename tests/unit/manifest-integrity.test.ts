import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// public/content/manifest.json is the contract between the content pipeline and the loader: the
// page fetches the paths it lists, and the budget report reads its numbers. The pipeline builds
// the manifest (pipeline/gltf/lib/manifest.mjs), and these checks hold the shipped file to its
// own contract, on the real content and on fixtures that break each rule once:
//
//   missing-file     every listed path must exist where its set says it lives
//   size-mismatch    the listed byte count must equal the file on disk
//   duplicate-path   a path may appear once per set; JSON.parse keeps only the last of duplicate
//                    keys, so the raw text is scanned for what the parsed value cannot show
//   totals-mismatch  each set total must equal the sum of its entries
//
// Path resolution follows the shipped layout: full-set keys live at the content root, half-set
// keys under half/, except files the two sets share, which are stored once at the content root
// (pipeline/gltf/optimize.mjs lists the environment HDR in both sets; src/main.ts loads it from
// the full root even on the half set). A second shared file would extend SHARED_WITH_FULL_SET
// together with those two call sites.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTENT_ROOT = join(REPO_ROOT, 'public', 'content');
const MANIFEST_PATH = join(CONTENT_ROOT, 'manifest.json');

/** Files stored once at the content root and listed in both sets. */
const SHARED_WITH_FULL_SET = ['env/school-field-cloudy-1k.hdr'];

const TOTAL_FIELDS = ['bytes', 'gpuBytes', 'triangles'] as const;
type TotalField = (typeof TOTAL_FIELDS)[number];

const SET_NAMES = ['full', 'half'] as const;

type ProblemKind =
  | 'manifest-shape'
  | 'duplicate-path'
  | 'missing-file'
  | 'size-mismatch'
  | 'totals-mismatch';

interface Problem {
  readonly kind: ProblemKind;
  readonly set?: string;
  readonly path?: string;
  readonly message: string;
}

function describeProblem(problem: Problem): string {
  const where = [problem.set, problem.path].filter(Boolean).join(' ');
  return where === '' ? `${problem.kind}: ${problem.message}` : `${problem.kind} (${where}): ${problem.message}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolves one JSON string escape after its backslash; \uXXXX reads the four hex digits after the u. */
function escapeText(raw: string, at: number): { text: string; width: number } {
  if (raw[at] === 'u') {
    return { text: String.fromCharCode(parseInt(raw.slice(at + 1, at + 5), 16)), width: 5 };
  }
  const named: Record<string, string> = {
    '"': '"',
    '\\': '\\',
    '/': '/',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
  };
  return { text: named[raw[at]] ?? raw[at], width: 1 };
}

interface KeyRecord {
  readonly scope: string;
  readonly key: string;
}

/**
 * Every object key in a JSON text, with the dotted path of the object that holds it, like
 * "sets.full.files". JSON.parse keeps the last of duplicate keys, so a path listed twice is
 * invisible in the parsed value; the raw text is the only place the duplicate still exists. The
 * scan tracks strings with the full JSON escape grammar, so an escaped quote cannot close a key
 * and an escape cannot hide a structural character. Malformed escapes never reach here: every
 * caller parses the same text first, and JSON.parse throws on malformed input.
 */
function objectKeys(raw: string): KeyRecord[] {
  const records: KeyRecord[] = [];
  const scopes: string[] = []; // scopes[0] is the document root; the recorded path omits it
  let inString = false;
  let escaped = false;
  let text = '';
  let pendingKey: string | null = null; // a string confirmed as a key, waiting for its value
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        const escape = escapeText(raw, i);
        text += escape.text;
        i += escape.width - 1;
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        let j = i + 1;
        while (j < raw.length && /\s/.test(raw[j])) j += 1;
        if (raw[j] === ':') {
          pendingKey = text;
          records.push({ scope: scopes.join('.').replace(/^\./, ''), key: text });
        }
      } else {
        text += ch;
      }
    } else if (ch === '"') {
      inString = true;
      text = '';
    } else if (ch === '{' || ch === '[') {
      // The document's one outermost container is the unnamed root; a nested object is labelled
      // by its key, and an array element has no key of its own.
      scopes.push(scopes.length === 0 ? '' : (pendingKey ?? '[]'));
      pendingKey = null;
    } else if (ch === '}' || ch === ']') {
      scopes.pop();
    } else if (ch !== ':' && !/\s/.test(ch)) {
      // A comma or the first character of a primitive value ends the reach of the previous key.
      pendingKey = null;
    }
  }
  return records;
}

/** Paths listed more than once inside one set's files map. */
function duplicateFilePaths(raw: string): { set: string; path: string }[] {
  const listed = new Map<string, Set<string>>();
  const duplicates: { set: string; path: string }[] = [];
  for (const { scope, key } of objectKeys(raw)) {
    const filesScope = /^sets\.([^.]+)\.files$/.exec(scope);
    if (filesScope === null) continue;
    const set = filesScope[1];
    const seen = listed.get(set) ?? new Set<string>();
    if (seen.has(key)) duplicates.push({ set, path: key });
    seen.add(key);
    listed.set(set, seen);
  }
  return duplicates;
}

/** Where a listed path lives on disk: full at the content root, half under half/, shared once. */
function contentPathFor(set: string, path: string, contentRoot: string): string {
  if (set === 'full' || SHARED_WITH_FULL_SET.includes(path)) return join(contentRoot, path);
  return join(contentRoot, 'half', path);
}

/** Runs every contract check against a parsed manifest, its raw text and the content root. */
function checkManifest(parsed: unknown, raw: string, contentRoot: string): Problem[] {
  const problems: Problem[] = [];
  if (!isObject(parsed) || !isObject(parsed['sets'])) {
    return [{ kind: 'manifest-shape', message: 'the manifest has no sets object' }];
  }
  const sets = parsed['sets'];
  const names = Object.keys(sets).sort();
  if (names.length !== SET_NAMES.length || names[0] !== 'full' || names[1] !== 'half') {
    problems.push({
      kind: 'manifest-shape',
      message: `the manifest carries the sets ${names.join(', ')}, expected full and half`,
    });
  }
  for (const duplicate of duplicateFilePaths(raw)) {
    problems.push({
      kind: 'duplicate-path',
      set: duplicate.set,
      path: duplicate.path,
      message: 'the same path is listed twice in one set; JSON.parse would keep only the last',
    });
  }
  for (const set of SET_NAMES) {
    const entry = sets[set];
    if (!isObject(entry) || !isObject(entry['files']) || !isObject(entry['totals'])) {
      problems.push({
        kind: 'manifest-shape',
        set,
        message: 'a set needs a files map and a totals object',
      });
      continue;
    }
    const files = entry['files'];
    const totals = entry['totals'];
    const sums: Record<TotalField, number> = { bytes: 0, gpuBytes: 0, triangles: 0 };
    for (const [path, file] of Object.entries(files)) {
      if (!isObject(file) || typeof file['bytes'] !== 'number') {
        problems.push({
          kind: 'manifest-shape',
          set,
          path,
          message: 'a file entry needs a numeric bytes field',
        });
        continue;
      }
      sums.bytes += file['bytes'];
      sums.gpuBytes += typeof file['gpuBytes'] === 'number' ? file['gpuBytes'] : 0;
      sums.triangles += typeof file['triangles'] === 'number' ? file['triangles'] : 0;
      const diskPath = contentPathFor(set, path, contentRoot);
      if (!existsSync(diskPath)) {
        problems.push({ kind: 'missing-file', set, path, message: `not found at ${diskPath}` });
        continue;
      }
      const diskBytes = statSync(diskPath).size;
      if (diskBytes !== file['bytes']) {
        problems.push({
          kind: 'size-mismatch',
          set,
          path,
          message: `listed ${file['bytes']} bytes, the file on disk has ${diskBytes}`,
        });
      }
    }
    for (const field of TOTAL_FIELDS) {
      const total = totals[field];
      if (typeof total !== 'number') {
        problems.push({
          kind: 'manifest-shape',
          set,
          message: `totals.${field} is not a number`,
        });
        continue;
      }
      if (total !== sums[field]) {
        problems.push({
          kind: 'totals-mismatch',
          set,
          message: `totals.${field} is ${total}, its entries sum to ${sums[field]}`,
        });
      }
    }
  }
  return problems;
}

// The fixtures below build a miniature content tree with the same shape as public/content: an
// environment file shared by both sets, one file at the full root, and a half tree under half/.
// Every control starts from the intact tree, so a failed control names the one rule it broke.

const FIXTURE_TEXTURE = {
  name: 'Dress_BaseColor',
  width: 512,
  height: 512,
  format: 'ktx2-etc1s',
  colorSpace: 'srgb',
  bytes: 100,
  gpuBytes: 700,
  floor: false,
};

const FIXTURE_FILES: Record<string, string> = {
  'env/school-field-cloudy-1k.hdr': 'hdr bytes shared by both sets',
  'rotunda.glb': 'full rotunda bytes',
  'looks/dress.glb': 'full dress bytes',
  'half/rotunda.glb': 'half rotunda bytes',
  'half/looks/dress.glb': 'half dress bytes',
};

function fixtureFile(
  content: string,
  triangles: number,
  textures: { gpuBytes: number }[] = [],
): Record<string, unknown> {
  return {
    bytes: Buffer.byteLength(content, 'utf8'),
    triangles,
    meshes: 1,
    nodes: 2,
    materials: 1,
    drawCalls: 1,
    textures: [...textures],
    gpuBytes: textures.reduce((total, texture) => total + texture.gpuBytes, 0),
    largestTexture: 512,
    largestNonFloorTexture: 512,
  };
}

function totalsFor(files: Record<string, Record<string, unknown>>): Record<TotalField, number> {
  const totals: Record<TotalField, number> = { bytes: 0, gpuBytes: 0, triangles: 0 };
  for (const file of Object.values(files)) {
    totals.bytes += file['bytes'] as number;
    totals.gpuBytes += file['gpuBytes'] as number;
    totals.triangles += file['triangles'] as number;
  }
  return totals;
}

function fixtureManifestText(): string {
  const fullFiles = {
    'env/school-field-cloudy-1k.hdr': fixtureFile(FIXTURE_FILES['env/school-field-cloudy-1k.hdr'], 0),
    'looks/dress.glb': fixtureFile(FIXTURE_FILES['looks/dress.glb'], 200, [FIXTURE_TEXTURE]),
    'rotunda.glb': fixtureFile(FIXTURE_FILES['rotunda.glb'], 100),
  };
  const halfFiles = {
    'env/school-field-cloudy-1k.hdr': fixtureFile(FIXTURE_FILES['env/school-field-cloudy-1k.hdr'], 0),
    'looks/dress.glb': fixtureFile(FIXTURE_FILES['half/looks/dress.glb'], 90, [FIXTURE_TEXTURE]),
    'rotunda.glb': fixtureFile(FIXTURE_FILES['half/rotunda.glb'], 80),
  };
  const manifest = {
    generated: '2026-10-14T00:00:00Z',
    sets: {
      full: { files: fullFiles, totals: totalsFor(fullFiles) },
      half: { files: halfFiles, totals: totalsFor(halfFiles) },
    },
    errors: [] as unknown[],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

function makeFixtureTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'fr-manifest-integrity-'));
  fixtureRoots.push(root);
  for (const [relative, content] of Object.entries(FIXTURE_FILES)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  writeFileSync(join(root, 'manifest.json'), fixtureManifestText());
  return root;
}

function readFixtureProblems(root: string): Problem[] {
  const raw = readFileSync(join(root, 'manifest.json'), 'utf8');
  return checkManifest(JSON.parse(raw), raw, root);
}

/** Lists rotunda.glb twice inside sets.full.files, with byte-identical values. */
function fixtureTextWithDuplicatePath(): string {
  const text = fixtureManifestText();
  const marker = '"files": {'; // sets.full.files is the first files map in document order
  const at = text.indexOf(marker);
  if (at < 0) throw new Error('the fixture text has no files map');
  const parsed = JSON.parse(text) as { sets: { full: { files: Record<string, unknown> } } };
  const entry = JSON.stringify(parsed.sets.full.files['rotunda.glb']);
  return `${text.slice(0, at + marker.length)}"rotunda.glb": ${entry},${text.slice(at + marker.length)}`;
}

function fixtureTextWithTotalBumped(field: TotalField): string {
  const parsed = JSON.parse(fixtureManifestText()) as {
    sets: Record<string, { totals: Record<TotalField, number> }>;
  };
  parsed.sets['full'].totals[field] += 1;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function expectOneProblem(problems: Problem[], kind: ProblemKind, set: string, path?: string): void {
  expect(problems.map(describeProblem)).toEqual([expect.stringContaining(kind)]);
  const only = problems[0];
  expect(only.kind).toBe(kind);
  expect(only.set).toBe(set);
  if (path !== undefined) expect(only.path).toBe(path);
}

describe('manifest-integrity: the shipped manifest against the files on disk', () => {
  let problems: Problem[] = [];
  beforeAll(() => {
    const raw = readFileSync(MANIFEST_PATH, 'utf8');
    problems = checkManifest(JSON.parse(raw), raw, CONTENT_ROOT);
  });

  it('lists no missing file', () => {
    expect(problems.filter((problem) => problem.kind === 'missing-file').map(describeProblem)).toEqual([]);
  });

  it('lists no byte size that differs from the file on disk', () => {
    expect(problems.filter((problem) => problem.kind === 'size-mismatch').map(describeProblem)).toEqual([]);
  });

  it('lists no path twice within a set', () => {
    expect(problems.filter((problem) => problem.kind === 'duplicate-path').map(describeProblem)).toEqual([]);
  });

  it('carries no set total that differs from the sum of its entries', () => {
    expect(problems.filter((problem) => problem.kind === 'totals-mismatch').map(describeProblem)).toEqual([]);
  });

  it('finds no defect at all, shape included', () => {
    expect(problems.map(describeProblem)).toEqual([]);
  });
});

describe('manifest-integrity: fixture controls', () => {
  it('accepts an intact fixture tree, including the shared environment file listed in both sets', () => {
    expect(readFixtureProblems(makeFixtureTree()).map(describeProblem)).toEqual([]);
  });

  it('rejects a listed file that is missing from disk', () => {
    const root = makeFixtureTree();
    rmSync(join(root, 'half', 'looks', 'dress.glb'));
    expectOneProblem(readFixtureProblems(root), 'missing-file', 'half', 'looks/dress.glb');
  });

  it('rejects a byte size that differs from the file on disk', () => {
    const root = makeFixtureTree();
    writeFileSync(join(root, 'rotunda.glb'), 'shorter');
    const problems = readFixtureProblems(root);
    expectOneProblem(problems, 'size-mismatch', 'full', 'rotunda.glb');
    expect(problems[0].message).toContain('listed 18 bytes');
    expect(problems[0].message).toContain('on disk has 7');
  });

  it('rejects a path listed twice, even when the parsed value looks intact', () => {
    const raw = fixtureTextWithDuplicatePath();
    expect(JSON.parse(raw)).toEqual(JSON.parse(fixtureManifestText()));
    const root = makeFixtureTree();
    expectOneProblem(checkManifest(JSON.parse(raw), raw, root), 'duplicate-path', 'full', 'rotunda.glb');
  });

  it('rejects a set total that differs from the sum of its entries', () => {
    for (const field of TOTAL_FIELDS) {
      const root = makeFixtureTree();
      const raw = fixtureTextWithTotalBumped(field);
      const problems = checkManifest(JSON.parse(raw), raw, root);
      expectOneProblem(problems, 'totals-mismatch', 'full');
      expect(problems[0].message).toContain(`totals.${field}`);
    }
  });
});
