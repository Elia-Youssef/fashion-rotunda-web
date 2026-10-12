import { describe, expect, it, vi } from 'vitest';

describe('handleTimestampError', () => {
  it('warns with the first error exactly once and stays silent for later errors', async () => {
    vi.resetModules();
    const { handleTimestampError } = await import('../../src/proof/gpu');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const firstError = new Error('first timestamp failure');
      handleTimestampError(firstError);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenNthCalledWith(1, '[archviz] timestamp resolve failed', firstError);
      expect(warn.mock.calls[0][1]).toBe(firstError);

      const laterErrors = [new Error('later timestamp failure'), 'timestamp unavailable', { code: 'unsupported' }];
      for (const error of laterErrors) {
        handleTimestampError(error);
        expect(warn).toHaveBeenCalledTimes(1);
      }
    } finally {
      warn.mockRestore();
    }
  });
});
