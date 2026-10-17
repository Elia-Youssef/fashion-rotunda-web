import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
// Bound a stuck child without leaving a process behind after the test.
const CLI_TIMEOUT_MS = 10_000;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fr-r2-cli-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runCli(name: 'plan' | 'manifest', args: string[]) {
  const env = { ...process.env };
  delete env.FR_R2_BUCKET;
  delete env.FR_R2_ORIGIN;
  const result = spawnSync(process.execPath, [join(projectRoot, 'pipeline/r2', `${name}.mjs`), ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function writeManifest(): string {
  const path = join(root, 'tiny manifest.json');
  writeFileSync(path, JSON.stringify({ files: [
    { path: 'looks/one.glb', key: 'content/one.glb', contentType: 'model/gltf+binary' },
    { path: 'catalog.json', key: 'content/two.json', contentType: 'application/json' },
  ] }));
  return path;
}

describe('R2 plan CLI', () => {
  it('prints commands using the default bucket and content directory', () => {
    const result = runCli('plan', ['--manifest', writeManifest()]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe([
      '# 2 files, 2 objects, 0 already uploaded, 2 to upload',
      'wrangler r2 object put fashion-rotunda-content/content/one.glb --file public/content/looks/one.glb' +
        ' --content-type model/gltf+binary --cache-control "public, max-age=31536000, immutable"',
      'wrangler r2 object put fashion-rotunda-content/content/two.json --file public/content/catalog.json' +
        ' --content-type application/json --cache-control "public, max-age=31536000, immutable"',
      '',
      '',
    ].join('\n'));
  });

  it('reports uploaded keys as skipped and prints only remaining commands', () => {
    const uploaded = join(root, 'uploaded keys.txt');
    writeFileSync(uploaded, '# done\r\n content/one.glb \r\n\r\n');
    const result = runCli('plan', ['--manifest', writeManifest(), '--uploaded', uploaded]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('# 2 files, 2 objects, 1 already uploaded, 1 to upload\n');
    expect(result.stdout).toContain('# skipped (already uploaded): content/one.glb (1 paths: looks/one.glb)\n');
    expect(result.stdout).not.toContain('object put fashion-rotunda-content/content/one.glb');
    expect(result.stdout).toContain('object put fashion-rotunda-content/content/two.json');
  });

  it('names a missing manifest in the wrapped error', () => {
    const missing = join(root, 'missing manifest.json');
    const result = runCli('plan', ['--manifest', missing]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`Error: the manifest could not be read at ${missing}:`);
  });

  it.each(['missing', 'directory'])('names an unreadable uploaded list (%s) in the wrapped error', (kind) => {
    const uploaded = join(root, 'unreadable list');
    if (kind === 'directory') mkdirSync(uploaded);
    const result = runCli('plan', ['--manifest', writeManifest(), '--uploaded', uploaded]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`Error: the uploaded list could not be read at ${uploaded}:`);
  });
});

describe('R2 manifest CLI', () => {
  it('writes deterministic content-addressed output under --out using the default origin', () => {
    const contentRoot = join(root, 'tiny content');
    mkdirSync(join(contentRoot, 'looks'), { recursive: true });
    writeFileSync(join(contentRoot, 'looks/one.glb'), 'abc');
    writeFileSync(join(contentRoot, 'catalog.json'), 'abc');
    const out = join(root, 'output folder', 'manifest.json');
    const args = ['--content-root', contentRoot, '--out', out];
    const first = runCli('manifest', args);
    expect(first.status).toBe(0);
    expect(first.stderr).toBe('');
    expect(first.stdout).toBe(
      'r2 manifest: 2 files, 2 objects, 6 bytes, 0 excluded\n' +
      `origin https://content.example.invalid\nwrote ${out}\n`,
    );
    const text = readFileSync(out, 'utf8');
    expect(JSON.parse(text)).toEqual({
      origin: 'https://content.example.invalid',
      files: [
        ['catalog.json', 'json', 'application/json'],
        ['looks/one.glb', 'glb', 'model/gltf+binary'],
      ].map(([path, extension, contentType]) => ({
        path,
        sha256: SHA256_OF_ABC,
        bytes: 3,
        contentType,
        key: `content/${SHA256_OF_ABC}.${extension}`,
        url: `https://content.example.invalid/content/${SHA256_OF_ABC}.${extension}`,
      })),
      excluded: [],
      totals: { files: 2, bytes: 6, objects: 2 },
    });
    const second = runCli('manifest', args);
    expect(second.status).toBe(0);
    expect(second.stderr).toBe('');
    expect(second.stdout).toBe(first.stdout);
    expect(readFileSync(out, 'utf8')).toBe(text);
  });
});
