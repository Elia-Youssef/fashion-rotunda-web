import { describe, expect, it, vi } from 'vitest';

import { lazyImport } from '../../src/ui/lazy-import';

// The memoized-import contract: a success stays for the page's life, a failure is forgotten so
// the next call starts a new import, and concurrent callers share one in-flight load.

describe('lazyImport', () => {
  it('keeps a successful load: every caller gets the same settled promise', async () => {
    const load = vi.fn(async () => ({ marker: 'screenshot module' }));
    const request = lazyImport(load);

    const first = request();
    const second = request();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ marker: 'screenshot module' });

    await expect(request()).resolves.toEqual({ marker: 'screenshot module' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed load: the next call starts a new import', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValue({ marker: 'recovered module' });
    const request = lazyImport(load);

    await expect(request()).rejects.toThrow('chunk unavailable');
    await expect(request()).resolves.toEqual({ marker: 'recovered module' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers share one in-flight load, including its failure', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(async () => {
      await gate;
      throw new Error('chunk unavailable');
    });
    const request = lazyImport(load);

    const first = request();
    const second = request();
    expect(second).toBe(first);
    release();
    await expect(first).rejects.toThrow('chunk unavailable');
    await expect(second).rejects.toThrow('chunk unavailable');
    expect(load).toHaveBeenCalledTimes(1);
  });
});
