import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveExportFile } from '../../pipeline/gltf/assemble.mjs';

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
});
