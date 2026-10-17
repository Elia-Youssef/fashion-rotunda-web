import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The shared contract ships as JavaScript without a declaration file.
import { ENVIRONMENT_FILE, ENVIRONMENT_WIDTH } from '../../pipeline/environment.mjs';

// The contract module exists so the converter, the optimizer manifest and the runtime catalogue
// cannot drift apart: renaming the HDR or changing its width must fail here before a first frame
// can point at an asset that no longer exists at the published path or size.
const contentRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'content');

describe('environment asset contract', () => {
  it('pins the runtime path and width to the shipped 1024-wide Radiance asset', () => {
    expect(ENVIRONMENT_FILE).toBe('env/school-field-cloudy-1k.hdr');
    expect(ENVIRONMENT_WIDTH).toBe(1024);
  });

  it('publishes the contract path as the catalogue environment the loader reads', () => {
    const catalog = JSON.parse(readFileSync(join(contentRoot, 'catalog.json'), 'utf8'));
    expect(catalog.environment).toEqual({ file: ENVIRONMENT_FILE });
  });

  it('charges the environment file to both budget sets in the manifest', () => {
    const manifest = JSON.parse(readFileSync(join(contentRoot, 'manifest.json'), 'utf8'));
    expect(manifest.sets.full.files[ENVIRONMENT_FILE]).toBeTruthy();
    expect(manifest.sets.half.files[ENVIRONMENT_FILE]).toBeTruthy();
  });

  it('keeps the shipped HDR dimensions at the contract width and its equirectangular half', () => {
    const head = readFileSync(join(contentRoot, ENVIRONMENT_FILE)).subarray(0, 4096).toString('ascii');
    expect(head.startsWith('#?RADIANCE')).toBe(true);
    const match = head.match(/-Y\s+(\d+)\s+\+X\s+(\d+)/);
    if (match === null) {
      throw new Error(`shipped HDR has no resolution line: ${ENVIRONMENT_FILE}`);
    }
    expect(Number(match[2])).toBe(ENVIRONMENT_WIDTH);
    expect(Number(match[1])).toBe(ENVIRONMENT_WIDTH / 2);
  });
});
