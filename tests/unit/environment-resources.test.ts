import { afterEach, describe, expect, it, vi } from 'vitest';
import { environmentResources } from '../../src/lighting/environment-resources';

afterEach(() => vi.restoreAllMocks());

describe('environmentResources', () => {
  it('returns and retains each owned resource once until cleanup', () => {
    const resources = environmentResources();
    const resource = { dispose: vi.fn() };
    expect(resources.own(resource)).toBe(resource);
    resources.own(resource);
    expect(resource.dispose).not.toHaveBeenCalled();
    resources.cleanup();
    resources.cleanup();
    expect(resource.dispose).toHaveBeenCalledTimes(1);
  });

  it('releases immediately and removes the resource from cleanup', () => {
    const resources = environmentResources();
    const resource = resources.own({ dispose: vi.fn() });
    resources.release(resource);
    expect(resource.dispose).toHaveBeenCalledTimes(1);
    resources.cleanup();
    expect(resource.dispose).toHaveBeenCalledTimes(1);
  });

  it('never retries a release whose disposer throws', () => {
    const resources = environmentResources();
    const failure = new Error('release failed');
    const resource = resources.own({ dispose: vi.fn(() => { throw failure; }) });
    expect(() => resources.release(resource)).toThrow(failure);
    resources.cleanup();
    expect(resource.dispose).toHaveBeenCalledTimes(1);
  });

  it('transfers only the named resources without disposing them', () => {
    const resources = environmentResources();
    const first = resources.own({ dispose: vi.fn() });
    const second = resources.own({ dispose: vi.fn() });
    const retained = resources.own({ dispose: vi.fn() });
    resources.transfer(first, second);
    expect(first.dispose).not.toHaveBeenCalled();
    expect(second.dispose).not.toHaveBeenCalled();
    resources.cleanup();
    expect(first.dispose).not.toHaveBeenCalled();
    expect(second.dispose).not.toHaveBeenCalled();
    expect(retained.dispose).toHaveBeenCalledTimes(1);
  });

  it('continues cleanup after failures and warns once with every error', () => {
    const resources = environmentResources();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failures = [new Error('first failed'), new Error('second failed')];
    const first = resources.own({ dispose: vi.fn(() => { throw failures[0]; }) });
    const middle = resources.own({ dispose: vi.fn() });
    const last = resources.own({ dispose: vi.fn(() => { throw failures[1]; }) });
    expect(() => resources.cleanup()).not.toThrow();
    for (const resource of [first, middle, last]) expect(resource.dispose).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith('[archviz] environment resource release failed', failures);
    resources.cleanup();
    for (const resource of [first, middle, last]) expect(resource.dispose).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn on successful or empty cleanup', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resources = environmentResources();
    resources.own({ dispose: vi.fn() });
    resources.cleanup();
    resources.cleanup();
    expect(warn).not.toHaveBeenCalled();
  });
});
