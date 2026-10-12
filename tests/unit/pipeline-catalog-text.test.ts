import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyLookText, LOOK_TEXT, validateLookText, writeCatalogTexts,
} from '../../pipeline/gltf/lib/catalog-text.mjs';
import type { LookText } from '../../pipeline/gltf/lib/catalog-text.mjs';
import { shippedJson } from '../../pipeline/gltf/lib/manifest.mjs';
import full from '../../public/content/catalog.json';
import half from '../../public/content/half/catalog.json';

const looks = full.looks;
const firstId = looks[0].id;

describe('catalogue text', () => {
  it('replaces all export wording and preserves all other metadata without mutating inputs', () => {
    const inputs = looks.map((look) => ({ ...look, description: 'Changed export text', future: 'retained' }));
    const before = structuredClone(inputs);
    const result = applyLookText(inputs);
    expect(result).toEqual(inputs.map((look) => ({ ...look, ...LOOK_TEXT[look.id] })));
    expect(inputs).toEqual(before);
  });

  it('rejects a missing table entry', () => {
    const text = { ...LOOK_TEXT };
    delete text[firstId];
    expect(() => validateLookText(looks, text)).toThrow(`missing look "${firstId}"`);
  });

  it('rejects an entry for a look outside the catalogue', () => {
    expect(() => validateLookText(looks, { ...LOOK_TEXT, unknown: LOOK_TEXT[firstId] }))
      .toThrow('unknown look "unknown"');
  });

  it('rejects duplicate catalogue identities', () => {
    expect(() => validateLookText([...looks, looks[0]])).toThrow(`repeats look "${firstId}"`);
  });

  it.each(['', '   '])('rejects an empty description %j', (description) => {
    expect(() => validateLookText(looks, { ...LOOK_TEXT, [firstId]: { ...LOOK_TEXT[firstId], description } }))
      .toThrow('non-empty description');
  });

  it('rejects non-ASCII descriptions before serialization can escape them', () => {
    const description = `Invalid ${String.fromCodePoint(0x2014)} copy`;
    expect(() => applyLookText(looks, { ...LOOK_TEXT, [firstId]: { ...LOOK_TEXT[firstId], description } }))
      .toThrow('must be ASCII');
  });

  it.each(['http://example.com/', 'javascript:alert(1)', '/source', 'https://', ''])(
    'rejects a non-HTTPS or malformed table URL %j', (sourceUrl) => {
      const text: Record<string, LookText> = {
        ...LOOK_TEXT, [firstId]: { ...LOOK_TEXT[firstId], sourceUrl },
      };
      expect(() => applyLookText(looks, text)).toThrow('must be an HTTPS URL');
    },
  );

  it('rejects non-ASCII source URLs', () => {
    const sourceUrl = `https://example.com/${String.fromCodePoint(0xe9)}`;
    expect(() => validateLookText(looks, { ...LOOK_TEXT, [firstId]: { ...LOOK_TEXT[firstId], sourceUrl } }))
      .toThrow('must be ASCII');
  });

  it('ships the complete text table in both catalogues', () => {
    for (const catalog of [full, half]) {
      expect(catalog.looks.map((look) => look.id).sort()).toEqual(Object.keys(LOOK_TEXT).sort());
      for (const look of catalog.looks) {
        expect({ description: look.description, sourceUrl: look.sourceUrl }).toEqual(LOOK_TEXT[look.id]);
      }
    }
  });

  it('writes both catalogues with the shipped JSON function and retains unrelated fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-text-'));
    try {
      const paths = ['full.json', 'half.json'].map((file) => join(dir, file));
      const catalog = {
        ...full, extra: 'retained', looks: looks.map((look) => ({ ...look, description: 'old' })),
      };
      for (const path of paths) writeFileSync(path, JSON.stringify(catalog));
      writeCatalogTexts(paths);
      const expected = shippedJson({ ...catalog, looks: applyLookText(catalog.looks) });
      for (const path of paths) expect(readFileSync(path, 'utf8')).toBe(expected);
      writeFileSync(paths[1], JSON.stringify({ ...catalog, looks: [] }));
      writeFileSync(paths[0], '  ' + JSON.stringify(catalog));
      const before = readFileSync(paths[0], 'utf8');
      expect(() => writeCatalogTexts(paths)).toThrow('unknown look');
      expect(readFileSync(paths[0], 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
