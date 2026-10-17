import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assemble, isWithinExportRoot, resolveExportFile } from '../../pipeline/gltf/assemble.mjs';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each([
  { name: 'win32', paths: win32, root: 'C:\\export' },
  { name: 'posix', paths: posix, root: '/export' },
])('export containment under $name semantics', ({ paths, root }) => {
  it.each(['..', '../x', '../other/file.glb'])('rejects outside path %s', (value) => {
    expect(isWithinExportRoot(root, paths.resolve(root, value), paths)).toBe(false);
  });

  it.each(['', 'looks/dress.glb', '..foo/x'])('accepts inside path %s', (value) => {
    expect(isWithinExportRoot(root, paths.resolve(root, value), paths)).toBe(true);
  });

  it.each(['..', '../x', '..\\x'])('rejects relative parent segment %s', (fromRoot) => {
    expect(isWithinExportRoot(root, 'unused', {
      relative: () => fromRoot,
      isAbsolute: paths.isAbsolute,
    })).toBe(false);
  });

  it('rejects an absolute relative result', () => {
    expect(isWithinExportRoot(root, 'unused', {
      relative: () => paths.resolve(root, 'x'),
      isAbsolute: paths.isAbsolute,
    })).toBe(false);
  });
});

it('rejects a candidate on another Windows drive', () => {
  expect(isWithinExportRoot('C:\\export', 'D:\\other\\file.glb', win32)).toBe(false);
});

describe('resolveExportFile', () => {
  const root = resolve('E:/Fashion-Rotunda-WebGPU/web-archviz-demo-planning/assets-src/source/unreal');

  it('rebases a historical checkout path beneath the current Unreal export root', () => {
    expect(resolveExportFile(
      root,
      'C:\\Users\\User\\Desktop\\web-archviz-demo-planning\\assets-src\\source\\unreal\\looks\\zoot-suit\\SM_ZootSuit.glb',
    )).toBe(resolve(root, 'looks/zoot-suit/SM_ZootSuit.glb'));
  });

  it('accepts a portable relative export path', () => {
    expect(resolveExportFile(root, 'looks/mondrian-dress/SM_Mondrian_Dress.glb'))
      .toBe(resolve(root, 'looks/mondrian-dress/SM_Mondrian_Dress.glb'));
  });

  it('rejects traversal outside the authoritative export root', () => {
    expect(() => resolveExportFile(root, '../other/file.glb')).toThrow('must stay below');
  });

  it('accepts an inside folder whose name starts with two dots', () => {
    expect(resolveExportFile(root, '..foo/x')).toBe(resolve(root, '..foo/x'));
  });

  it('rejects an empty recorded path', () => {
    expect(() => resolveExportFile(root, '')).toThrow('must stay below');
  });
});

describe('assemble', () => {
  it('rejects an unknown look selection before writing anything', async () => {
    const exportRoot = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-assemble-'));
    const out = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-assembled-'));
    temporaryDirectories.push(exportRoot, out);
    // The seven catalogue identities with no geometry at all: the selection check runs
    // after the catalogue validates and before any look, copy or directory is written.
    writeFileSync(resolve(exportRoot, 'catalog-source.json'), JSON.stringify({
      looks: ['wallis-dress', 'zoot-suit', 'new-look-dress', 'mondrian-dress', 'jumpsuit-dress',
        'blue-silk-dress', 'geoffrey-beene'].map((slug) => ({ slug })),
      rotunda: { file: 'rotunda.glb' },
      plinth: { file: 'plinth.glb' },
    }));

    await expect(assemble({ only: 'no-such-look', exportRoot, out, log: () => {} }))
      .rejects.toThrow('Unknown look selection no-such-look');
    expect(readdirSync(out)).toEqual([]);
  });
});
