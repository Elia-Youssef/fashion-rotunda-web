import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildR2Manifest,
  manifestText,
  normalizeOrigin,
} from '../../pipeline/r2/lib/manifest.mjs';
import {
  contentTypeFor,
  exclusionReasonFor,
  objectKeyFor,
  walkContentFiles,
} from '../../pipeline/r2/lib/objects.mjs';
import type { DirEntryLike, ExclusionRule, ListDir } from '../../pipeline/r2/lib/objects.mjs';

const ORIGIN = 'https://content.example.invalid';

// The published SHA-256 test vector for the ASCII string 'abc': the algorithm itself is pinned,
// not just that some digest came out.
const SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function makeFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'fr-r2-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

/** A listing that hands back every directory in reverse name order. */
const reversedReaddir: ListDir = (dir) => readdirSync(dir, { withFileTypes: true }).reverse();

describe('walkContentFiles', () => {
  it('returns every regular file as a sorted POSIX-relative path', () => {
    const root = makeFixture({
      'rotunda.glb': 'aaa',
      'looks/b.glb': 'bbb',
      'looks/a.glb': 'ccc',
      'half/looks/a.glb': 'ddd',
    });
    expect(walkContentFiles(root)).toEqual([
      'half/looks/a.glb',
      'looks/a.glb',
      'looks/b.glb',
      'rotunda.glb',
    ]);
  });

  it('is independent of the order the file system returns entries in', () => {
    const root = makeFixture({ 'b/x.json': '1', 'a/y.json': '2', 'z.json': '3' });
    expect(walkContentFiles(root, reversedReaddir)).toEqual(walkContentFiles(root));
  });

  it('stops on an entry that is neither a file nor a directory', () => {
    const weird: DirEntryLike = { name: 'dangling', isDirectory: () => false, isFile: () => false };
    expect(() => walkContentFiles('unused', () => [weird])).toThrow(/not a regular file or directory/);
  });
});

describe('objectKeyFor and contentTypeFor', () => {
  it('addresses ordinary content by hash and lowercased extension', () => {
    expect(objectKeyFor('looks/a.GLB', SHA256_OF_ABC)).toBe(`content/${SHA256_OF_ABC}.glb`);
    expect(contentTypeFor('looks/a.GLB')).toBe('model/gltf+binary');
    expect(contentTypeFor('thumbs/x.jpg')).toBe('image/jpeg');
    expect(contentTypeFor('music/x.ogg')).toBe('audio/ogg');
  });

  it('keeps the fixed directory keys the Basis transcoder is loaded by', () => {
    expect(objectKeyFor('basis/basis_transcoder.js', SHA256_OF_ABC)).toBe(
      'content/basis/basis_transcoder.js',
    );
    expect(objectKeyFor('basis/basis_transcoder.wasm', SHA256_OF_ABC)).toBe(
      'content/basis/basis_transcoder.wasm',
    );
  });

  it('stops on an extensionless path or an unknown extension', () => {
    expect(() => objectKeyFor('README', SHA256_OF_ABC)).toThrow(/no addressable key/);
    expect(() => contentTypeFor('sounds/sound.flac')).toThrow(/no content type is known/);
  });
});

describe('exclusionReasonFor', () => {
  const rules: ExclusionRule[] = [
    { exact: 'scratch.json', reason: 'a scratch file the page never fetches' },
    { prefix: 'docs/', reason: 'prose is not runtime content' },
  ];

  it('matches by exact path and by folder prefix, first rule wins', () => {
    expect(exclusionReasonFor('scratch.json', rules)).toBe('a scratch file the page never fetches');
    expect(exclusionReasonFor('docs/x.txt', rules)).toBe('prose is not runtime content');
    expect(exclusionReasonFor('docs/readme.txt', [{ prefix: 'docs/', reason: 'one' }, { exact: 'docs/readme.txt', reason: 'two' }])).toBe('one');
  });

  it('returns null for runtime content', () => {
    expect(exclusionReasonFor('rotunda.glb', rules)).toBeNull();
  });
});

describe('normalizeOrigin', () => {
  it('strips trailing slashes and rejects anything but http(s) URLs', () => {
    expect(normalizeOrigin('https://content.example.invalid/')).toBe(
      'https://content.example.invalid',
    );
    expect(normalizeOrigin('http://host.example//')).toBe('http://host.example');
    expect(() => normalizeOrigin('content.example.invalid')).toThrow(/must be an http or https URL/);
    expect(() => normalizeOrigin('https://not a url')).toThrow(/must be an http or https URL/);
  });
});

describe('buildR2Manifest', () => {
  it('pins the SHA-256 vector and matches an independent digest and the file size', () => {
    const root = makeFixture({ 'vec/abc.json': 'abc', 'looks/one.glb': 'glb bytes here' });
    const manifest = buildR2Manifest({ root, origin: ORIGIN });
    const vector = manifest.files.find((entry) => entry.path === 'vec/abc.json');
    const look = manifest.files.find((entry) => entry.path === 'looks/one.glb');

    expect(vector?.sha256).toBe(SHA256_OF_ABC);
    expect(look?.sha256).toBe(
      createHash('sha256').update(Buffer.from('glb bytes here', 'utf8')).digest('hex'),
    );
    expect(look?.bytes).toBe(Buffer.byteLength('glb bytes here', 'utf8'));
  });

  it('builds key and URL from the hash and the origin', () => {
    const root = makeFixture({ 'looks/one.glb': 'abc' });
    const entry = buildR2Manifest({ root, origin: `${ORIGIN}/` }).files[0];
    expect(entry).toMatchObject({
      path: 'looks/one.glb',
      sha256: SHA256_OF_ABC,
      bytes: 3,
      contentType: 'model/gltf+binary',
      key: `content/${SHA256_OF_ABC}.glb`,
      url: `${ORIGIN}/content/${SHA256_OF_ABC}.glb`,
    });
  });

  it('changes the hash and the key when one byte changes', () => {
    const root = makeFixture({ 'looks/one.glb': 'abc' });
    const before = buildR2Manifest({ root, origin: ORIGIN }).files[0];
    writeFileSync(join(root, 'looks/one.glb'), 'abd');
    const after = buildR2Manifest({ root, origin: ORIGIN }).files[0];

    expect(after.sha256).not.toBe(before.sha256);
    expect(after.key).not.toBe(before.key);
    expect(after.bytes).toBe(before.bytes);
  });

  it('gives two paths with identical bytes one key and counts one object', () => {
    const root = makeFixture({ 'catalog.json': 'same bytes', 'half/catalog.json': 'same bytes' });
    const manifest = buildR2Manifest({ root, origin: ORIGIN });
    const keys = manifest.files.map((entry) => entry.key);

    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(manifest.totals).toEqual({ files: 2, bytes: 20, objects: 1 });
    expect(manifest.files[0].url).toBe(manifest.files[1].url);
  });

  it('keeps the transcoder pair on fixed keys while identical bytes elsewhere stay addressed', () => {
    const root = makeFixture({
      'basis/basis_transcoder.js': 'transcoder code',
      'copy/of-transcoder.js': 'transcoder code',
    });
    const manifest = buildR2Manifest({ root, origin: ORIGIN });
    const byPath = new Map(manifest.files.map((entry) => [entry.path, entry]));

    expect(byPath.get('basis/basis_transcoder.js')?.key).toBe('content/basis/basis_transcoder.js');
    expect(byPath.get('basis/basis_transcoder.js')?.contentType).toBe('text/javascript');
    expect(byPath.get('copy/of-transcoder.js')?.key).not.toBe('content/basis/basis_transcoder.js');
    expect(byPath.get('copy/of-transcoder.js')?.key).toMatch(/^content\/[0-9a-f]{64}\.js$/);
  });

  it('records excluded files with their reason and uploads the rest', () => {
    const root = makeFixture({ 'keep.json': '{}', 'scratch.json': 'x', 'docs/note.txt': 'y' });
    const manifest = buildR2Manifest({
      root,
      origin: ORIGIN,
      exclusions: [
        { exact: 'scratch.json', reason: 'a scratch file the page never fetches' },
        { prefix: 'docs/', reason: 'prose is not runtime content' },
      ],
    });

    expect(manifest.files.map((entry) => entry.path)).toEqual(['keep.json']);
    expect(manifest.excluded).toEqual([
      { path: 'docs/note.txt', reason: 'prose is not runtime content' },
      { path: 'scratch.json', reason: 'a scratch file the page never fetches' },
    ]);
  });
});

describe('manifestText determinism and ASCII', () => {
  it('is byte-identical across reruns, across trees and across walk orders', () => {
    const files = { 'z.json': 'last', 'a/b.json': 'first', 'basis/basis_transcoder.wasm': 'w' };
    const rootA = makeFixture(files);
    const rootB = makeFixture({ 'basis/basis_transcoder.wasm': 'w', 'z.json': 'last', 'a/b.json': 'first' });

    const textA1 = manifestText(buildR2Manifest({ root: rootA, origin: ORIGIN }));
    const textA2 = manifestText(buildR2Manifest({ root: rootA, origin: ORIGIN }));
    const textB = manifestText(buildR2Manifest({ root: rootB, origin: ORIGIN }));
    const textReversed = manifestText(
      buildR2Manifest({ root: rootA, origin: ORIGIN, readdir: reversedReaddir }),
    );

    expect(textA2).toBe(textA1);
    expect(textB).toBe(textA1);
    expect(textReversed).toBe(textA1);
  });

  it('escapes every non-ASCII character and round-trips through JSON.parse', () => {
    const root = makeFixture({ 'looks/caf\u00e9.glb': 'abc' });
    const manifest = buildR2Manifest({ root, origin: ORIGIN });
    const text = manifestText(manifest);

    expect(text).toMatch(/^[\n\x20-\x7e]*$/);
    expect(text).toContain('caf\\u00e9.glb');
    expect(JSON.parse(text)).toEqual(manifest);
  });
});
