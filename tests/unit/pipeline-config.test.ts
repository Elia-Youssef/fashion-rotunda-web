import { afterEach, describe, expect, it, vi } from 'vitest';
import { ktxBin, pipelineEnv } from '../../pipeline/config.mjs';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('pipeline tool environment', () => {
  it('puts the KTX binaries first on PATH and keeps every inherited variable', () => {
    const env = pipelineEnv();
    expect(env.PATH).toBe(`${ktxBin};${process.env.PATH ?? ''}`);
    for (const [key, value] of Object.entries(process.env)) {
      if (key === 'PATH') continue;
      expect(env[key]).toBe(value);
    }
  });

  it('lets FR_KTX_BIN and FR_FFMPEG_BIN redirect the tool search', async () => {
    vi.stubEnv('FR_KTX_BIN', 'X:\\ktx');
    vi.stubEnv('FR_FFMPEG_BIN', 'X:\\ffmpeg\\bin');
    vi.resetModules();
    const config = await import('../../pipeline/config.mjs');
    expect(config.ktxBin).toBe('X:\\ktx');
    expect(config.ffmpegExe).toBe('X:\\ffmpeg\\bin\\ffmpeg.exe');
    expect(config.ffprobeExe).toBe('X:\\ffmpeg\\bin\\ffprobe.exe');
    expect(config.pipelineEnv().PATH?.startsWith('X:\\ktx;')).toBe(true);
  });
});
