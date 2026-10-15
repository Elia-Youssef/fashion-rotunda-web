import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createShowroomConfig, omitEmittedBasisTranscoderPlugin } from '../../vite.config';

const config = createShowroomConfig({});

// The guard runs inside the bundler's generateBundle hook, so these tests drive the hook against
// bundle objects shaped like the real output: vite 8 emits through rolldown, whose output assets
// carry fileName, name, names and originalFileNames, with the declared names pointing at the
// source file an emission came from (transformToMutableRollupOutputAsset in rolldown's
// bindingify-input-options chunk). A basis_transcoder copy that survives to the written output
// is a second, unreferenced copy of the pair the page already fetches from /content/basis/.

const KTX2_LOADER_SOURCE = join(
  process.cwd(),
  'node_modules',
  'three',
  'examples',
  'jsm',
  'loaders',
  'KTX2Loader.js',
);

/** An output asset as the bundler builds it from a source file outside the module graph. */
function emittedAsset(
  fileName: string,
  sourcePath: string,
  source: string | Uint8Array,
): Record<string, unknown> {
  return {
    type: 'asset',
    fileName,
    name: basenameOf(sourcePath),
    names: [basenameOf(sourcePath)],
    originalFileNames: [sourcePath],
    needsCodeReference: false,
    source,
  };
}

function basenameOf(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

describe('the emitted basis transcoder guard', () => {
  it('is registered on the build and only the build', () => {
    expect(config.plugins).toContain(omitEmittedBasisTranscoderPlugin);
    expect(omitEmittedBasisTranscoderPlugin.apply).toBe('build');
    expect(typeof omitEmittedBasisTranscoderPlugin.generateBundle).toBe('function');
  });

  it('targets references the installed KTX2Loader still carries', () => {
    // The guard exists because these module-level fallback references make the bundler emit the
    // pair. If a three upgrade removes them, the guard has nothing left to drop: revisit the
    // guard and this file together instead of keeping a no-op.
    const source = readFileSync(KTX2_LOADER_SOURCE, 'utf8');
    expect(source).toContain("new URL( '../libs/basis/basis_transcoder.wasm', import.meta.url )");
    expect(source).toContain("new URL( '../libs/basis/basis_transcoder.js', import.meta.url )");
  });

  it('drops the emitted pair and keeps every other entry', () => {
    const bundle: Record<string, unknown> = {
      'index-B1ueC0de.js': { type: 'chunk', fileName: 'index-B1ueC0de.js', code: 'export {};' },
      'basis_transcoder-DxYz1234.js': emittedAsset(
        'basis_transcoder-DxYz1234.js',
        'node_modules/three/examples/jsm/libs/basis/basis_transcoder.js',
        '/* transcoder wrapper */',
      ),
      'poster-9f8e7.jpg': emittedAsset(
        'poster-9f8e7.jpg',
        'public/poster/poster.jpg',
        new Uint8Array([255]),
      ),
      'basis_transcoder-C0ffee00.wasm': emittedAsset(
        'basis_transcoder-C0ffee00.wasm',
        'node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm',
        new Uint8Array([0]),
      ),
    };

    omitEmittedBasisTranscoderPlugin.generateBundle({}, bundle);

    expect(Object.keys(bundle).sort()).toEqual(['index-B1ueC0de.js', 'poster-9f8e7.jpg']);
  });

  it('drops entries that only carry the emitted file name', () => {
    const bundle: Record<string, unknown> = {
      'basis_transcoder-aBc123.js': {
        type: 'asset',
        fileName: 'basis_transcoder-aBc123.js',
        source: '/* transcoder wrapper */',
      },
      'basis_transcoder.wasm': {
        type: 'asset',
        fileName: 'basis_transcoder.wasm',
        source: new Uint8Array([0]),
      },
    };

    omitEmittedBasisTranscoderPlugin.generateBundle({}, bundle);

    expect(Object.keys(bundle)).toEqual([]);
  });

  it('leaves a bundle without basis transcoder copies untouched', () => {
    const bundle: Record<string, unknown> = {
      'index-B1ueC0de.js': { type: 'chunk', fileName: 'index-B1ueC0de.js', code: 'export {};' },
      'styles-D1rtyL0ad.png': {
        type: 'asset',
        fileName: 'styles-D1rtyL0ad.png',
        source: new Uint8Array([1]),
      },
    };
    const before = Object.keys(bundle);

    omitEmittedBasisTranscoderPlugin.generateBundle({}, bundle);

    expect(Object.keys(bundle)).toEqual(before);
  });
});
