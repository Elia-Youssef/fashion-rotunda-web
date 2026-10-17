import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildR2Manifest } from '../../pipeline/r2/lib/manifest.mjs';
import type { R2Manifest } from '../../pipeline/r2/lib/manifest.mjs';
import {
  CACHE_CONTROL,
  DEFAULT_BUCKET,
  parseUploadedList,
  planUploads,
  renderPlanText,
} from '../../pipeline/r2/lib/plan.mjs';

// The planner's contract is that it computes and prints commands and nothing else: no child
// process is ever started. Every spawning entry point of node:child_process is replaced with a
// recorder, so any spawn attempt, from this module or anything it pulls in, fails this file.
const childProcessCalls = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('node:child_process', () => {
  const record = (name: string) =>
    vi.fn((...args: unknown[]) => {
      childProcessCalls.calls.push(`${name} ${String(args[0])}`);
      return undefined;
    });
  return {
    spawn: record('spawn'),
    spawnSync: record('spawnSync'),
    exec: record('exec'),
    execSync: record('execSync'),
    execFile: record('execFile'),
    execFileSync: record('execFileSync'),
    fork: record('fork'),
  };
});

const ORIGIN = 'https://content.example.invalid';

function makeFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'fr-r2-plan-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

/** A manifest shaped like the builder's output, without touching the file system. */
function manifestOf(entries: { path: string; key: string; contentType: string }[]): R2Manifest {
  return {
    origin: ORIGIN,
    files: entries.map((entry) => ({
      path: entry.path,
      sha256: '0'.repeat(64),
      bytes: 1,
      contentType: entry.contentType,
      key: entry.key,
      url: `${ORIGIN}/${entry.key}`,
    })),
    excluded: [],
    totals: { files: entries.length, bytes: entries.length, objects: new Set(entries.map((e) => e.key)).size },
  };
}

beforeEach(() => {
  childProcessCalls.calls.length = 0;
});

describe('parseUploadedList', () => {
  it('reads one key per line and drops blanks, comments and stray whitespace', () => {
    const text = '# already in the bucket\r\ncontent/aa.glb\n\n  content/bb.json  \r\n';
    expect(parseUploadedList(text)).toEqual(['content/aa.glb', 'content/bb.json']);
  });
});

describe('planUploads', () => {
  it('pins the default bucket', () => {
    expect(DEFAULT_BUCKET).toBe('fashion-rotunda-content');
  });

  it('prints one wrangler put per object with type and the immutable cache rule', () => {
    const manifest = manifestOf([
      { path: 'looks/one.glb', key: 'content/aa.glb', contentType: 'model/gltf+binary' },
    ]);
    const plan = planUploads(manifest, { bucket: 'demo-bucket' });

    expect(plan.commands).toEqual([
      'wrangler r2 object put demo-bucket/content/aa.glb --file public/content/looks/one.glb' +
        ` --content-type model/gltf+binary --cache-control "${CACHE_CONTROL}"`,
    ]);
    expect(CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
    expect(plan.counts).toEqual({ files: 1, objects: 1, toUpload: 1, skipped: 0 });
  });

  it('collapses entries that share a key into one command on the first path', () => {
    const manifest = manifestOf([
      { path: 'catalog.json', key: 'content/shared.json', contentType: 'application/json' },
      { path: 'half/catalog.json', key: 'content/shared.json', contentType: 'application/json' },
      { path: 'rotunda.glb', key: 'content/bb.glb', contentType: 'model/gltf+binary' },
    ]);
    const plan = planUploads(manifest, { bucket: 'demo-bucket' });

    expect(plan.commands).toEqual([
      'wrangler r2 object put demo-bucket/content/shared.json --file public/content/catalog.json' +
        ` --content-type application/json --cache-control "${CACHE_CONTROL}"`,
      'wrangler r2 object put demo-bucket/content/bb.glb --file public/content/rotunda.glb' +
        ` --content-type model/gltf+binary --cache-control "${CACHE_CONTROL}"`,
    ]);
    expect(plan.counts).toEqual({ files: 3, objects: 2, toUpload: 2, skipped: 0 });
  });

  it('skips keys the already-uploaded list names and reports their paths', () => {
    const manifest = manifestOf([
      { path: 'catalog.json', key: 'content/shared.json', contentType: 'application/json' },
      { path: 'half/catalog.json', key: 'content/shared.json', contentType: 'application/json' },
      { path: 'rotunda.glb', key: 'content/bb.glb', contentType: 'model/gltf+binary' },
    ]);
    const plan = planUploads(manifest, { bucket: 'demo-bucket', uploaded: ['content/shared.json'] });

    expect(plan.commands.map((line) => line.split(' ')[4])).toEqual(['demo-bucket/content/bb.glb']);
    expect(plan.skipped).toEqual([
      { key: 'content/shared.json', paths: ['catalog.json', 'half/catalog.json'] },
    ]);
    expect(plan.counts).toEqual({ files: 3, objects: 2, toUpload: 1, skipped: 1 });
  });

  it('refuses a segment that would not survive the shell as one argument', () => {
    const manifest = manifestOf([
      { path: 'my look.glb', key: 'content/aa.glb', contentType: 'model/gltf+binary' },
    ]);
    expect(() => planUploads(manifest, { bucket: 'demo-bucket' })).toThrow(/would not survive the shell/);
  });

  it('stops on a manifest without a files array or with an incomplete entry', () => {
    expect(() => planUploads({ origin: ORIGIN } as unknown as R2Manifest, { bucket: 'b' })).toThrow(
      /no files array/,
    );
    expect(() =>
      planUploads(manifestOf([{ path: 'a.glb', key: 'content/a.glb', contentType: '' }]), { bucket: 'b' }),
    ).toThrow(/no contentType/);
  });

  it('stops on an entry whose field is not a string', () => {
    const entries = [
      { path: 42, key: 'content/a.glb', contentType: 'model/gltf+binary' },
      { path: 'a.glb', key: 'content/a.glb', contentType: null },
    ] as unknown as Parameters<typeof manifestOf>[0];
    expect(() => planUploads(manifestOf([entries[0]]), { bucket: 'b' })).toThrow(/no path/);
    expect(() => planUploads(manifestOf([entries[1]]), { bucket: 'b' })).toThrow(/no contentType/);
  });

  it('stops on an entry missing a field', () => {
    const noPath = [{ key: 'content/a.glb', contentType: 'model/gltf+binary' }] as unknown as
      Parameters<typeof manifestOf>[0];
    const noKey = [{ path: 'a.glb', key: '', contentType: 'model/gltf+binary' }] as unknown as
      Parameters<typeof manifestOf>[0];
    expect(() => planUploads(manifestOf(noPath), { bucket: 'b' })).toThrow(/no path/);
    expect(() => planUploads(manifestOf(noKey), { bucket: 'b' })).toThrow(/no key/);
  });

  it('names the offending segment when a command part cannot survive the shell', () => {
    const manifest = manifestOf([
      { path: 'a.glb', key: 'content/a.glb', contentType: 'model/gltf+binary' },
    ]);
    expect(() => planUploads(manifest, { bucket: 'my bucket' })).toThrow(/as one argument: my bucket/);
    const badKey = manifestOf([
      { path: 'a.glb', key: 'content/a glb', contentType: 'model/gltf+binary' },
    ]);
    expect(() => planUploads(badKey, { bucket: 'b' })).toThrow(/as one argument: content\/a glb/);
  });

  it('stops on a files field that is not an array', () => {
    const manifest = { origin: ORIGIN, files: 'rotunda.glb' } as unknown as R2Manifest;
    expect(() => planUploads(manifest, { bucket: 'b' })).toThrow(/no files array/);
  });
});

describe('renderPlanText', () => {
  it('renders the summary, the skip notes and the commands in one deterministic block', () => {
    const manifest = manifestOf([
      { path: 'catalog.json', key: 'content/shared.json', contentType: 'application/json' },
      { path: 'half/catalog.json', key: 'content/shared.json', contentType: 'application/json' },
      { path: 'rotunda.glb', key: 'content/bb.glb', contentType: 'model/gltf+binary' },
    ]);
    const text = renderPlanText(planUploads(manifest, { bucket: 'demo-bucket', uploaded: ['content/bb.glb'] }));

    expect(text).toBe(
      [
        '# 3 files, 2 objects, 1 already uploaded, 1 to upload',
        '# skipped (already uploaded): content/bb.glb (1 paths: rotunda.glb)',
        'wrangler r2 object put demo-bucket/content/shared.json --file public/content/catalog.json' +
          ` --content-type application/json --cache-control "${CACHE_CONTROL}"`,
        '',
      ].join('\n'),
    );
  });

  it('renders asymmetric counts and every path of both skipped keys', () => {
    const manifest = manifestOf([
      { path: 'catalog.json', key: 'content/shared.json', contentType: 'application/json' },
      { path: 'half/catalog.json', key: 'content/shared.json', contentType: 'application/json' },
      { path: 'rotunda.glb', key: 'content/bb.glb', contentType: 'model/gltf+binary' },
      { path: 'env.hdr', key: 'content/cc.hdr', contentType: 'image/vnd.radiance' },
    ]);
    const plan = planUploads(manifest, {
      bucket: 'demo-bucket',
      uploaded: ['content/shared.json', 'content/cc.hdr'],
    });

    expect(plan.counts).toEqual({ files: 4, objects: 3, toUpload: 1, skipped: 2 });
    expect(renderPlanText(plan)).toBe(
      [
        '# 4 files, 3 objects, 2 already uploaded, 1 to upload',
        '# skipped (already uploaded): content/shared.json (2 paths: catalog.json, half/catalog.json)',
        '# skipped (already uploaded): content/cc.hdr (1 paths: env.hdr)',
        'wrangler r2 object put demo-bucket/content/bb.glb --file public/content/rotunda.glb' +
          ` --content-type model/gltf+binary --cache-control "${CACHE_CONTROL}"`,
        '',
      ].join('\n'),
    );
  });
});

describe('planner process contract', () => {
  it('plans a real content tree without starting any process', () => {
    const root = makeFixture({
      'catalog.json': 'same bytes',
      'half/catalog.json': 'same bytes',
      'basis/basis_transcoder.js': 'transcoder',
      'rotunda.glb': 'abc',
    });
    const manifest = buildR2Manifest({ root, origin: ORIGIN });
    const plan = planUploads(manifest, { bucket: 'demo-bucket', uploaded: ['content/basis/basis_transcoder.js'] });
    const text = renderPlanText(plan);

    expect(childProcessCalls.calls).toEqual([]);
    for (const line of text.split('\n')) {
      expect(line === '' || line.startsWith('#') || line.startsWith('wrangler r2 object put ')).toBe(true);
    }
    // The fixed transcoder key was skipped and the shared catalog key planned exactly once.
    expect(plan.counts).toEqual({ files: 4, objects: 3, toUpload: 2, skipped: 1 });
  });
});
