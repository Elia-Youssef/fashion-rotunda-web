import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  expectedBytes,
  formatProgress,
  progressRatio,
  receivedBytes,
  underContentBase,
} from '../../src/loading/progress';
import type { ManifestFile, ResourceEntry } from '../../src/loading/progress';

// The names and the bytes field are the real ones from public/content/manifest.json
// (sets.full.files), shrunk to what the arithmetic needs: four files plus one the first frame
// must not count.
const manifest: Record<string, ManifestFile> = {
  'env/school-field-cloudy-1k.hdr': { bytes: 1678323 },
  'rotunda.glb': { bytes: 7095496 },
  'plinth.glb': { bytes: 1126464 },
  'looks/wallis-dress.glb': { bytes: 3250932 },
  'looks/zoot-suit.glb': { bytes: 4922068 },
};

/** One Resource Timing reading. Names arrive from the browser as absolute URLs. */
function entry(name: string, transferSize: number, responseEnd = 0): ResourceEntry {
  return { name, transferSize, responseEnd };
}

describe('expectedBytes', () => {
  it('counts no environment bytes for the default sky, which is generated in memory', () => {
    expect(expectedBytes(manifest, 'looks/wallis-dress.glb', null)).toBe(
      7095496 + 1126464 + 3250932,
    );
  });

  it('sums the environment, rotunda, plinth and first look under the ?sky=hdr diagnostic', () => {
    expect(
      expectedBytes(manifest, 'looks/wallis-dress.glb', 'env/school-field-cloudy-1k.hdr'),
    ).toBe(1678323 + 7095496 + 1126464 + 3250932);
  });

  it('does not count the looks the first frame does not need', () => {
    expect(expectedBytes(manifest, 'looks/zoot-suit.glb', 'env/school-field-cloudy-1k.hdr')).toBe(
      1678323 + 7095496 + 1126464 + 4922068,
    );
  });

  it('counts a missing file as zero, not as a failure', () => {
    expect(
      expectedBytes(manifest, 'looks/not-in-the-set.glb', 'env/school-field-cloudy-1k.hdr'),
    ).toBe(1678323 + 7095496 + 1126464);
    expect(expectedBytes({}, 'looks/wallis-dress.glb', 'env/school-field-cloudy-1k.hdr')).toBe(0);
  });
});

describe('receivedBytes', () => {
  it('sums the transfer sizes of the entries under the content base', () => {
    const entries = [
      entry('http://localhost:5173/content/rotunda.glb', 7095496),
      entry('http://localhost:5173/content/plinth.glb', 1126464),
      entry('http://localhost:5173/content/looks/wallis-dress.glb', 3250932),
    ];
    expect(receivedBytes(entries, '/content')).toBe(7095496 + 1126464 + 3250932);
  });

  it('ignores entries outside the base and counts cache hits as zero', () => {
    // A cross-origin response under the same path counts too, and honestly: without
    // Timing-Allow-Origin the browser reports transferSize 0 for it, so it adds nothing.
    const entries = [
      entry('http://localhost:5173/src/main.ts', 2048),
      entry('http://localhost:5173/content/rotunda.glb', 0),
      entry('https://cdn.example.com/content/rotunda.glb', 0),
    ];
    expect(receivedBytes(entries, '/content')).toBe(0);
  });

  it('separates the half set from the full one', () => {
    const entries = [
      entry('/content/rotunda.glb', 100),
      entry('/content/half/rotunda.glb', 50),
    ];
    expect(receivedBytes(entries, '/content')).toBe(150);
    expect(receivedBytes(entries, '/content/half')).toBe(50);
  });

  it('does not match a path that merely starts the same', () => {
    expect(receivedBytes([entry('/content-other/x.glb', 10)], '/content')).toBe(0);
  });

  it('accepts relative names, as the unit tests and the half set URLs write them', () => {
    expect(underContentBase('/content/rotunda.glb', '/content')).toBe(true);
    expect(underContentBase('/content/half/rotunda.glb', '/content')).toBe(true);
    expect(underContentBase('/content', '/content')).toBe(false);
    expect(underContentBase('not a url', '/content')).toBe(false);
  });
});

describe('progressRatio', () => {
  it('is the received share of the expected bytes', () => {
    expect(progressRatio(500, 1000)).toBe(0.5);
  });

  it('clamps below zero and above one', () => {
    expect(progressRatio(-10, 1000)).toBe(0);
    expect(progressRatio(2000, 1000)).toBe(1);
  });

  it('means one when nothing was expected', () => {
    expect(progressRatio(0, 0)).toBe(1);
    expect(progressRatio(50, 0)).toBe(1);
  });
});

describe('formatProgress', () => {
  it('reads as one decimal in MB, received of expected', () => {
    expect(formatProgress(4_200_000, 10_900_000)).toBe('4.2 MB of 10.9 MB');
  });

  it('starts at zero and never shows a negative', () => {
    expect(formatProgress(0, 10_900_000)).toBe('0.0 MB of 10.9 MB');
    expect(formatProgress(-1, 10_900_000)).toBe('0.0 MB of 10.9 MB');
  });

  it('rounds, it does not floor: 1_049_999 is 1.0, 1_050_000 is 1.1', () => {
    expect(formatProgress(1_049_999, 2_000_000)).toBe('1.0 MB of 2.0 MB');
    expect(formatProgress(1_050_000, 2_000_000)).toBe('1.1 MB of 2.0 MB');
  });

  it('shows the default room without the environment file', () => {
    expect(formatProgress(0, expectedBytes(manifest, 'looks/wallis-dress.glb', null))).toBe(
      '0.0 MB of 11.5 MB',
    );
  });

  it('shows the ?sky=hdr room the manifest on main describes', () => {
    expect(
      formatProgress(
        0,
        expectedBytes(manifest, 'looks/wallis-dress.glb', 'env/school-field-cloudy-1k.hdr'),
      ),
    ).toBe(
      '0.0 MB of 13.2 MB',
    );
  });
});

// expectedBytes holds the rotunda's and the plinth's manifest keys as constants, because the
// catalogue names them and the manifest is keyed by file name. This reads both shipped documents
// so a rename in the pipeline fails here instead of silently zeroing two thirds of the total.
describe('the shipped documents', () => {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function asRecord(value: unknown, what: string): Record<string, unknown> {
    if (!isRecord(value)) {
      throw new Error(`${what} is not an object`);
    }
    return value;
  }

  function readJson(relative: string): unknown {
    return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
  }

  it('names the static files expectedBytes counts, and the manifest carries their bytes', () => {
    const catalog = asRecord(readJson('../../public/content/catalog.json'), 'catalog.json');
    const manifestJson = asRecord(readJson('../../public/content/manifest.json'), 'manifest.json');
    const files = asRecord(
      asRecord(asRecord(manifestJson.sets, 'sets').full, 'sets.full').files,
      'sets.full.files',
    );
    const rotunda = asRecord(catalog.rotunda, 'catalog.rotunda').file;
    const plinth = asRecord(catalog.plinth, 'catalog.plinth').file;
    const environment = asRecord(catalog.environment, 'catalog.environment').file;
    const looks = catalog.looks;
    if (!Array.isArray(looks) || looks.length === 0) {
      throw new Error('catalog.looks is empty');
    }
    const firstLook = asRecord(looks[0], 'catalog.looks[0]').file;

    const keys = Object.keys(files);
    expect(keys).toContain(rotunda);
    expect(keys).toContain(plinth);
    expect(keys).toContain(environment);
    expect(keys).toContain(firstLook);

    // The same four files through the real arithmetic: a key that stopped matching would drop
    // its bytes to 0 and this sum would not be the sum of the four entries.
    const bytes = (name: unknown): number => {
      const entry = asRecord(files[String(name)], `sets.full.files[${String(name)}]`).bytes;
      return typeof entry === 'number' ? entry : Number.NaN;
    };
    const real: Record<string, ManifestFile> = {};
    for (const [name, value] of Object.entries(files)) {
      const size = asRecord(value, `sets.full.files[${name}]`).bytes;
      if (typeof size === 'number') {
        real[name] = { bytes: size };
      }
    }
    expect(expectedBytes(real, String(firstLook), String(environment))).toBe(
      bytes(environment) + bytes(rotunda) + bytes(plinth) + bytes(firstLook),
    );
    expect(expectedBytes(real, String(firstLook), null)).toBe(
      bytes(rotunda) + bytes(plinth) + bytes(firstLook),
    );
  });
});
