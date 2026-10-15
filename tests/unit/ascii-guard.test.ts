// @vitest-environment node
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Repository rule: tracked text files hold printable ASCII plus tab, newline and
// carriage return. A character beyond ASCII that a visitor must see is written as a
// backslash-u escape in the source, so any raw byte outside the allowed set marks a
// file that broke the rule on its way into the tree. Lines and columns count bytes:
// in a clean file a byte is one character, and in a broken file the byte offsets are
// what a fix needs to find the defect.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const PRINTABLE_START = 0x20;
const PRINTABLE_END = 0x7e;

// Content that must never be read as text: meshes, compressed textures, images, audio
// and native code. Extensions that are not in the tree yet (ktx2, webp, exr) stay in
// the list so new content of the same kind is covered from the start.
const BINARY_EXTENSIONS = new Set([
  '.glb',
  '.ktx2',
  '.png',
  '.jpg',
  '.webp',
  '.ogg',
  '.m4a',
  '.wasm',
  '.hdr',
  '.exr',
]);

// The fallback walk mirrors the directories that hold tracked text. It skips the
// folders Git ignores as build output and never descends outside those roots, so
// machine-local ignored material does not turn into a failure.
const WALK_ROOTS = ['.github', 'src', 'tests', 'pipeline', 'tools', 'public'];
const WALK_SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'test-results',
  'playwright-report',
  'coverage',
  'assets-src',
]);

// A flooded file (a binary format missed by the extension list, for example) must not
// drown the failure message in repeats of the same defect.
const MAX_VIOLATIONS_PER_FILE = 20;

const GIT_LISTING = 'git ls-files';
const WALK_LISTING = 'filesystem walk';

interface Violation {
  file: string;
  line: number;
  column: number;
  byte: number;
}

interface Scan {
  violations: Violation[];
  // True when the scan stopped at the per-file cap, so more bytes may be broken.
  truncated: boolean;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(path));
}

function isByteAllowed(byte: number): boolean {
  return byte === TAB || byte === LF || byte === CR
    || (byte >= PRINTABLE_START && byte <= PRINTABLE_END);
}

function scanBytes(file: string, bytes: Buffer): Scan {
  const violations: Violation[] = [];
  let line = 1;
  let column = 1;
  let truncated = false;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (!isByteAllowed(byte)) {
      if (violations.length >= MAX_VIOLATIONS_PER_FILE) {
        truncated = true;
        break;
      }
      violations.push({ file, line, column, byte });
    }
    if (byte === LF) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { violations, truncated };
}

function scanFile(root: string, file: string): Scan {
  return scanBytes(file, readFileSync(join(root, file)));
}

function formatViolation(violation: Violation): string {
  const hex = violation.byte.toString(16).padStart(2, '0');
  return `${violation.file}:${violation.line}:${violation.column} byte 0x${hex}`;
}

function scanAll(root: string, files: string[]): string {
  const lines: string[] = [];
  for (const file of files) {
    const scan = scanFile(root, file);
    for (const violation of scan.violations) {
      lines.push(formatViolation(violation));
    }
    if (scan.truncated) {
      lines.push(`${file}: report stopped after ${MAX_VIOLATIONS_PER_FILE} bytes outside ASCII`);
    }
  }
  return lines.join('\n');
}

function listTrackedWithGit(root: string): string[] | null {
  try {
    const listing = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      // The default forwards the child's stderr to ours; a directory outside any
      // repository is the expected trigger for the walk and must stay quiet.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return listing.split('\0').filter((file) => file !== '' && !isBinaryPath(file)).sort();
  } catch {
    // No git executable, no repository above root, or a git safety stop: the walk takes over.
    return null;
  }
}

function walkTextFiles(root: string): string[] {
  const files: string[] = [];
  // Markdown never enters the repository (the ignore rules exclude it), so the walk
  // skips it the way the git listing never sees it. The .git entry is a directory in
  // the main checkout and a file in a linked worktree; either way it is git metadata.
  const accept = (name: string): boolean =>
    name !== '.git' && !name.endsWith('.md') && !isBinaryPath(name);
  const visit = (absolute: string, prefix: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!WALK_SKIPPED_DIRECTORIES.has(entry.name)) {
          visit(join(absolute, entry.name), `${prefix}${entry.name}/`);
        }
      } else if (entry.isFile() && accept(`${prefix}${entry.name}`)) {
        files.push(`${prefix}${entry.name}`);
      }
    }
  };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && accept(entry.name)) {
      files.push(entry.name);
    }
  }
  for (const directory of WALK_ROOTS) {
    const absolute = join(root, directory);
    if (existsSync(absolute)) {
      visit(absolute, `${directory}/`);
    }
  }
  return files.sort();
}

function listTextFiles(root: string): { files: string[]; mode: string } {
  const tracked = listTrackedWithGit(root);
  if (tracked) {
    return { files: tracked, mode: GIT_LISTING };
  }
  return { files: walkTextFiles(root), mode: WALK_LISTING };
}

describe('ascii guard', () => {
  const listing = listTextFiles(ROOT);

  it(`every tracked text file contains only ASCII bytes (file list: ${listing.mode})`, () => {
    expect(listing.files.length, 'the file list must not come back empty').toBeGreaterThan(0);
    const report = scanAll(ROOT, listing.files);
    expect(report, `${listing.files.length} tracked text files scanned via ${listing.mode}`).toBe('');
  });

  it('fallback walk over the same roots finds the known text files', () => {
    const walked = walkTextFiles(ROOT);
    expect(walked.length, 'the fallback walk must find text files').toBeGreaterThan(0);
    expect(walked, 'known text files missing from the fallback walk').toEqual(
      expect.arrayContaining(['package.json', 'src/main.ts', 'public/_headers']),
    );
  });

  it('skips binary content by extension and still scans extensionless files', () => {
    expect(isBinaryPath('public/content/rotunda.glb')).toBe(true);
    expect(isBinaryPath('public/content/basis/basis_transcoder.wasm')).toBe(true);
    expect(isBinaryPath('public/content/music/music-01.ogg')).toBe(true);
    expect(isBinaryPath('tests/e2e/visual.spec.ts-snapshots/first-look-webgl2-win32.png')).toBe(true);
    expect(isBinaryPath('docs/reference/fashion-rotunda-hero.jpg')).toBe(true);
    expect(isBinaryPath('src/main.ts')).toBe(false);
    expect(isBinaryPath('public/content/catalog.json')).toBe(false);
    expect(isBinaryPath('public/brand/fashion-rotunda-icon.svg')).toBe(false);
    expect(isBinaryPath('public/_headers')).toBe(false);
    expect(isBinaryPath('.gitignore')).toBe(false);
  });

  describe('scanner fixtures in a temporary directory', () => {
    let fixtures = '';

    beforeAll(() => {
      fixtures = mkdtempSync(join(tmpdir(), 'ascii-guard-'));
      // One byte per violation: each multi-byte UTF-8 sequence fails once per byte,
      // which is what pins the byte-counted line and column.
      writeFileSync(join(fixtures, 'non-breaking-space.txt'), 'ascii kept\r\nnext \u00A0here\r\n');
      writeFileSync(join(fixtures, 'zero-width-space.txt'), 'a\u200Bb\n');
      writeFileSync(join(fixtures, 'form-feed.txt'), 'line one\nline two\ftwo more\n');
      writeFileSync(join(fixtures, 'allowed-controls.txt'), 'tab\there\ncr\rend\r\nlast line\n');
      writeFileSync(join(fixtures, 'empty.txt'), '');
    });

    afterAll(() => {
      if (fixtures !== '') {
        rmSync(fixtures, { recursive: true, force: true });
      }
    });

    it('flags a non-breaking space with its file, line and column', () => {
      const scan = scanBytes('non-breaking-space.txt', readFileSync(join(fixtures, 'non-breaking-space.txt')));
      expect(scan.truncated).toBe(false);
      expect(scan.violations, 'both bytes of the two-byte UTF-8 sequence are outside ASCII').toEqual([
        { file: 'non-breaking-space.txt', line: 2, column: 6, byte: 0xc2 },
        { file: 'non-breaking-space.txt', line: 2, column: 7, byte: 0xa0 },
      ]);
    });

    it('flags a zero-width space with its file, line and column', () => {
      const scan = scanBytes('zero-width-space.txt', readFileSync(join(fixtures, 'zero-width-space.txt')));
      expect(scan.truncated).toBe(false);
      expect(scan.violations, 'all three bytes of the UTF-8 sequence are outside ASCII').toEqual([
        { file: 'zero-width-space.txt', line: 1, column: 2, byte: 0xe2 },
        { file: 'zero-width-space.txt', line: 1, column: 3, byte: 0x80 },
        { file: 'zero-width-space.txt', line: 1, column: 4, byte: 0x8b },
      ]);
    });

    it('flags a control character other than tab, newline and carriage return', () => {
      const scan = scanBytes('form-feed.txt', readFileSync(join(fixtures, 'form-feed.txt')));
      expect(scan.violations).toEqual([
        { file: 'form-feed.txt', line: 2, column: 9, byte: 0x0c },
      ]);
    });

    it('accepts tab, newline, carriage return, CRLF and an empty file', () => {
      for (const name of ['allowed-controls.txt', 'empty.txt']) {
        const scan = scanBytes(name, readFileSync(join(fixtures, name)));
        expect(scan.violations, `${name} must scan clean`).toEqual([]);
      }
    });

    it('caps a flooded file at the report limit and says so', () => {
      const flooded = Buffer.from(Array.from({ length: MAX_VIOLATIONS_PER_FILE + 10 }, () => 0xa0));
      const scan = scanBytes('flooded.txt', flooded);
      expect(scan.truncated).toBe(true);
      expect(scan.violations.length, 'the report keeps only the first bytes of a flooded file')
        .toBe(MAX_VIOLATIONS_PER_FILE);
    });
  });

  describe('a deliberately broken tree for the fallback scan', () => {
    let broken = '';

    beforeAll(() => {
      broken = mkdtempSync(join(tmpdir(), 'ascii-guard-tree-'));
      writeFileSync(join(broken, 'package.json'), '{\n  "name": "synthetic"\n}\n');
      writeFileSync(join(broken, 'README.md'), '# local markdown is never tracked\n');
      mkdirSync(join(broken, 'src'), { recursive: true });
      writeFileSync(join(broken, 'src', 'ok.ts'), 'export const fine = "ascii";\n');
      writeFileSync(join(broken, 'src', 'bad.ts'), 'const ok = 1;\nconst note = "\u00e9";\n');
      mkdirSync(join(broken, 'public', 'content'), { recursive: true });
      writeFileSync(join(broken, 'public', 'content', 'model.glb'), Buffer.from([0x00, 0x01, 0xff, 0xfe]));
    });

    afterAll(() => {
      if (broken !== '') {
        rmSync(broken, { recursive: true, force: true });
      }
    });

    it('takes the filesystem walk when git cannot list the tree', () => {
      expect(listTextFiles(broken), 'a directory outside any repository has no git listing').toEqual({
        files: ['package.json', 'src/bad.ts', 'src/ok.ts'],
        mode: WALK_LISTING,
      });
    });

    it('fails the broken tree with file, line and column and skips binary and markdown', () => {
      const files = walkTextFiles(broken);
      expect(files, 'binary content and markdown stay out of the scan').toEqual([
        'package.json',
        'src/bad.ts',
        'src/ok.ts',
      ]);
      expect(scanAll(broken, files), 'the broken file is named with line and column')
        .toBe('src/bad.ts:2:15 byte 0xc3\nsrc/bad.ts:2:16 byte 0xa9');
    });
  });
});
