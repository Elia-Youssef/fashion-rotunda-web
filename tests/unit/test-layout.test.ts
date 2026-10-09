// @vitest-environment node
import { readdirSync } from 'node:fs';
import { posix, relative, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import playwrightConfig from '../../playwright.config';
import vitestConfig from '../../vitest.config';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UNIT_DIRECTORY = 'tests/unit';
// Generated output, dependencies, local evidence and Git metadata are not repository source.
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', 'dist', 'briefs', '.worktrees', 'test-results', 'playwright-report', '.git',
]);

function repositoryFiles(directory = ''): string[] {
  return readdirSync(resolve(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      return EXCLUDED_DIRECTORIES.has(entry.name) ? [] : repositoryFiles(path);
    }
    return entry.isFile() ? [path] : [];
  });
}

function inside(path: string, directory: string): boolean {
  const relative = posix.relative(directory, path);
  return relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative);
}

describe('test file layout', () => {
  const include = vitestConfig.test?.include;
  const testDir = playwrightConfig.testDir;
  if (!include?.length || !testDir) {
    throw new Error('Test layout requires explicit Vitest include and Playwright testDir settings.');
  }
  const e2eDirectory = relative(ROOT, resolve(ROOT, testDir)).replaceAll('\\', '/');
  const files = repositoryFiles();
  const unitFiles = files.filter((path) => inside(path, UNIT_DIRECTORY));
  const collectedUnitFiles = files.filter((path) =>
    include.some((pattern) => posix.matchesGlob(path, pattern)),
  );
  const e2eFiles = files.filter((path) => path.endsWith('.spec.ts') && inside(path, e2eDirectory));

  it('keeps every .test.ts file in the unit directory', () => {
    const stray = files.filter((path) => path.endsWith('.test.ts') && !inside(path, UNIT_DIRECTORY));
    expect(stray, 'Unit test files outside the unit directory').toEqual([]);
  });

  it('keeps every .spec.ts file in the configured e2e directory', () => {
    const stray = files.filter((path) => path.endsWith('.spec.ts') && !inside(path, e2eDirectory));
    expect(stray, 'E2e test files outside Playwright testDir').toEqual([]);
  });

  it('collects every file in the unit directory with the configured include patterns', () => {
    stdout.write(`Test layout: ${collectedUnitFiles.length} unit files, ${e2eFiles.length} e2e files.\n`);
    const missed = unitFiles.filter((path) => !collectedUnitFiles.includes(path));
    expect(missed, 'Unit directory files missed by Vitest include').toEqual([]);
  });
});
