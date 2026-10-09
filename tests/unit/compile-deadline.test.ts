import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHADER_COMPILATION_DEADLINE_MS, withCompilationDeadline } from '../../src/renderer/compile-deadline';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('withCompilationDeadline', () => {
  it('clears the watchdog after fast success and preserves the value', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    expect(await withCompilationDeadline(Promise.resolve('compiled'))).toBe('compiled');
    expect(vi.getTimerCount()).toBe(0);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('clears the watchdog after fast rejection and preserves the error', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const failure = new Error('compilation failed');
    await expect(withCompilationDeadline(Promise.reject(failure))).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('uses the unchanged deadline and clears the watchdog after a true timeout', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    let settled = false;
    const result = withCompilationDeadline(new Promise<void>(() => {}));
    const checked = expect(result).rejects.toThrow('Shader compilation timed out');
    void result.catch(() => { settled = true; });
    expect(SHADER_COMPILATION_DEADLINE_MS).toBe(15_000);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await checked;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
