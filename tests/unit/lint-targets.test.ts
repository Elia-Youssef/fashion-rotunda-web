// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Three isolated runs took 4.307, 8.471 and 5.248 s on the desktop (2026-10-17, 50 percent
// CPU cap, other Node and Chrome processes present). The 60 s limit leaves headroom above
// the 37 s seen under load on 2026-10-16 while still bounding the full-source lint pass.
const LINT_COVERAGE_TIMEOUT_MS = 60_000;

it('lints every tracked JavaScript and TypeScript source file', async () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const [command, ...arguments_] = scripts.lint.split(/\s+/) as string[];
  expect(command).toBe('eslint');
  expect(arguments_.filter((argument) => argument.startsWith('--'))).toEqual(['--max-warnings=0']);
  const targets = arguments_.filter((argument) => !argument.startsWith('--'));
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  // Shipped public content includes the vendored texture transcoder, not project source.
  const expected = tracked.filter((path) => /\.[cm]?[jt]s$/.test(path) && !path.startsWith('public/'));
  const results = await new ESLint({ cwd: ROOT }).lintFiles(targets);
  const covered = new Set(results.map((result) => relative(ROOT, result.filePath).replaceAll('\\', '/')));
  expect(expected.filter((path) => !covered.has(path)), 'Tracked source files missed by npm run lint')
    .toEqual([]);
}, LINT_COVERAGE_TIMEOUT_MS);
