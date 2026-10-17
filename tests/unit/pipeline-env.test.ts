import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blenderExe, contentDir, root, sourceDir } from '../../pipeline/config.mjs';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
}));

// No real process or asset access is available to the imported CLI.
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawnSync }));
vi.mock('node:fs', () => ({
  copyFileSync: mocks.copyFileSync,
  mkdirSync: mocks.mkdirSync,
  readFileSync: mocks.readFileSync,
  rmSync: mocks.rmSync,
  statSync: mocks.statSync,
}));
vi.mock('../../pipeline/config.mjs', async () => {
  const { resolve } = await import('node:path');
  const root = resolve('environment test fixture');
  return {
    root,
    blenderExe: resolve(root, 'Blender 5.2', 'blender.exe'),
    contentDir: resolve(root, 'public', 'content'),
    sourceDir: resolve(root, 'assets-src', 'source'),
  };
});

const source = resolve(sourceDir, 'environment', 'school-field-cloudy-2k.exr');
const output = resolve(contentDir, 'env', 'school-field-cloudy-1k.hdr');
const temporary = resolve(contentDir, 'env', `.school-field-cloudy-${process.pid}.hdr`);
const converter = resolve(root, 'pipeline', 'blender', 'env.py');
const hdr = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 512 +X 1024\n');

async function runCli() {
  // @ts-expect-error The side-effect CLI has no declaration file; no exports are used.
  await import('../../pipeline/env.mjs');
}

function expectUnpublished() {
  expect(mocks.copyFileSync).not.toHaveBeenCalled();
  expect(mocks.statSync).not.toHaveBeenCalled();
  expect(mocks.readFileSync).not.toHaveBeenCalled();
  expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(temporary, { force: true });
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.spawnSync.mockReturnValue({ status: 0 });
  mocks.readFileSync.mockReturnValue(hdr);
  mocks.statSync.mockReturnValue({ size: hdr.length });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  const childProcess = await import('node:child_process');
  expect(childProcess.spawnSync).toBe(mocks.spawnSync);
  expect(vi.isMockFunction(childProcess.spawnSync)).toBe(true);
  expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
  vi.restoreAllMocks();
});

describe('environment conversion CLI', () => {
  it('passes the source, temporary output and 1024 width to Blender without starting a process', async () => {
    await runCli();

    expect(mocks.spawnSync).toHaveBeenCalledExactlyOnceWith(
      blenderExe,
      ['--background', '--factory-startup', '--python', converter, '--', source, temporary, '1024'],
      { stdio: 'inherit' },
    );
  });

  it('reads and validates the temporary HDR before publishing to the runtime path', async () => {
    await runCli();

    expect(mocks.mkdirSync).toHaveBeenCalledExactlyOnceWith(resolve(contentDir, 'env'), { recursive: true });
    expect(mocks.readFileSync).toHaveBeenCalledExactlyOnceWith(temporary);
    expect(mocks.copyFileSync).toHaveBeenCalledExactlyOnceWith(temporary, output);
    expect(mocks.rmSync.mock.calls).toEqual([[temporary, { force: true }], [temporary, { force: true }]]);
    expect(mocks.statSync).toHaveBeenCalledExactlyOnceWith(output);
    expect(console.log).toHaveBeenCalledExactlyOnceWith(
      `environment: env/school-field-cloudy-1k.hdr, ${hdr.length} bytes`,
    );
    expect(mocks.rmSync.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.spawnSync.mock.invocationCallOrder[0]!);
    expect(mocks.readFileSync.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.copyFileSync.mock.invocationCallOrder[0]!);
    expect(mocks.copyFileSync.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.rmSync.mock.invocationCallOrder[1]!);
  });

  it('propagates the missing Blender spawn error without publishing', async () => {
    const missingTool = Object.assign(new Error(`spawnSync ${blenderExe} ENOENT`), { code: 'ENOENT' });
    mocks.spawnSync.mockReturnValue({ error: missingTool, status: null });

    await expect(runCli()).rejects.toBe(missingTool);
    expectUnpublished();
  });

  it('reports the failed converter status when the source EXR is missing without publishing', async () => {
    // env.py owns the source check; its failure reaches this CLI as exit status 1.
    mocks.spawnSync.mockImplementation((_executable, args) => {
      expect(args[5]).toBe(source);
      return { status: 1 };
    });

    await expect(runCli()).rejects.toThrow('environment conversion exited 1');
    expectUnpublished();
  });

  it('reports a converter exit without a status without publishing', async () => {
    mocks.spawnSync.mockReturnValue({ status: null });

    await expect(runCli()).rejects.toThrow('environment conversion exited without a status');
    expectUnpublished();
  });

  it('rejects a non-Radiance temporary file without publishing', async () => {
    mocks.readFileSync.mockReturnValue(Buffer.from('not an HDR\n-Y 512 +X 1024\n'));

    await expect(runCli()).rejects.toThrow(`environment output is not a Radiance HDR: ${temporary}`);
    expect(mocks.copyFileSync).not.toHaveBeenCalled();
    expect(mocks.statSync).not.toHaveBeenCalled();
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(temporary, { force: true });
  });

  it('rejects a Radiance temporary file with no resolution line without publishing', async () => {
    mocks.readFileSync.mockReturnValue(Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n'));

    await expect(runCli()).rejects
      .toThrow(`environment output has no Radiance resolution line: ${temporary}`);
    expect(mocks.copyFileSync).not.toHaveBeenCalled();
    expect(mocks.statSync).not.toHaveBeenCalled();
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(temporary, { force: true });
  });

  it.each([
    { width: 2048, height: 512 },
    { width: 1024, height: 1024 },
  ])('rejects a $width x $height HDR without replacing the runtime asset', async ({ width, height }) => {
    mocks.readFileSync.mockReturnValue(Buffer.from(`#?RADIANCE\n\n-Y ${height} +X ${width}\n`));

    await expect(runCli()).rejects.toThrow(`environment output is ${width}x${height}, expected 1024x512`);
    expect(mocks.copyFileSync).not.toHaveBeenCalled();
    expect(mocks.statSync).not.toHaveBeenCalled();
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(temporary, { force: true });
  });

  it('reads past comment lines to the resolution line and publishes a valid long-header HDR', async () => {
    // Radiance files may carry comment lines between the format line and the resolution line, so
    // the 4096-byte header window must reach across them.
    mocks.readFileSync.mockReturnValue(
      Buffer.from(`#?RADIANCE\n# ${'x'.repeat(200)}\n\n-Y 512 +X 1024\n`),
    );

    await runCli();

    expect(mocks.readFileSync).toHaveBeenCalledExactlyOnceWith(temporary);
    expect(mocks.copyFileSync).toHaveBeenCalledExactlyOnceWith(temporary, output);
  });

  it('publishes an HDR whose resolution line separates its numbers with runs of whitespace', async () => {
    mocks.readFileSync.mockReturnValue(Buffer.from('#?RADIANCE\n\n-Y 512   +X  1024\n'));

    await runCli();

    expect(mocks.readFileSync).toHaveBeenCalledExactlyOnceWith(temporary);
    expect(mocks.copyFileSync).toHaveBeenCalledExactlyOnceWith(temporary, output);
  });
});
