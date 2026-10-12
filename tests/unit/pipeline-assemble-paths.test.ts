import { posix, resolve, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isWithinExportRoot, resolveExportFile } from '../../pipeline/gltf/assemble.mjs';

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
