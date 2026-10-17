import { describe, expect, it, vi } from 'vitest';
import type { PostChain } from '../../src/post/chain';
import type { GovernorDiagnostics } from '../../src/post/governor';
import {
  createGovernorPublisher, createMemoryPublisher, createPostStatePublisher, createTimestampResolveBridge,
} from '../../src/proof/publishers';

function diagnostics(overrides: Partial<GovernorDiagnostics> = {}): GovernorDiagnostics {
  return {
    historyVersion: 1, level: 'full', recoveryEligible: true, activity: 'observing',
    consecutiveOverBudget: 1, patience: 2, cooldownRemainingMs: 1.2,
    recoveryElapsedMs: 12.9, recoveryQualificationMs: 10000, recoveryThresholdMs: 13.36,
    budgetMs: 16.7, lastP95Ms: null, events: [], ...overrides,
  };
}

describe('proof publishers', () => {
  it('publishes exact governor tokens, history updates and off state', () => {
    const dataset: DOMStringMap = {};
    const publish = createGovernorPublisher(dataset);
    publish(null);
    expect(dataset).toEqual({ governor: 'off', governorLog: '[]' });
    publish(diagnostics());
    expect(dataset['governor']).toBe('level=full;activity=observing;eligible=1;cooldown=2;' +
      'patience=1/2;qualify=12/10000;p95=none;budget=16.7;threshold=13.36');
    const events: GovernorDiagnostics['events'] = [{
      direction: 'down', from: 'full', to: 'no-ssr', p95Ms: 20, budgetMs: 16.7,
      atMs: 100, reason: 'over budget',
    }];
    publish(diagnostics({ historyVersion: 2, events, level: 'no-ssr', activity: 'cooldown',
      recoveryEligible: false, lastP95Ms: 20.25, budgetMs: 20, recoveryThresholdMs: 16 }));
    expect(dataset['governor']).toBe('level=no-ssr;activity=cooldown;eligible=0;cooldown=2;' +
      'patience=1/2;qualify=12/10000;p95=20.3;budget=20.0;threshold=16.00');
    expect(dataset['governorLog']).toBe(JSON.stringify(events));
    publish(null);
    expect(dataset).toEqual({ governor: 'off', governorLog: '[]' });
  });

  it('publishes post tokens in order, including half, full and inactive features', () => {
    const dataset: DOMStringMap = {};
    const governor = vi.fn();
    const publish = createPostStatePublisher(dataset, governor);
    publish(null, null);
    expect(dataset['post']).toBe('off');
    const features: PostChain['features'] = {
      ao: true, traa: true, msaa: true, ssgi: 'half', ssr: true,
      bloom: true, lut: true, vignette: true, dof: 'on',
    };
    const state = diagnostics();
    publish(features, state);
    expect(dataset['post']).toBe('ao,traa,msaa,ssgi-half,ssr,bloom,lut,vignette,dof');
    publish({ ...features, ssgi: 'full', dof: 'ready' }, null);
    expect(dataset['post']).toBe('ao,traa,msaa,ssgi,ssr,bloom,lut,vignette');
    publish({ ao: false, traa: false, msaa: false, ssgi: 'off', ssr: false,
      bloom: false, lut: false, vignette: false, dof: 'off' }, null);
    expect(dataset['post']).toBe('off');
    expect(governor.mock.calls).toEqual([[null], [state], [null], [null]]);
  });

  it('avoids repeated dataset access for unchanged post and memory values', () => {
    const target: DOMStringMap = {};
    const get = vi.fn((object: DOMStringMap, key: string) => object[key]);
    const set = vi.fn((object: DOMStringMap, key: string, value: string) => {
      object[key] = value;
      return true;
    });
    const dataset = new Proxy(target, { get, set });
    const publishMemory = createMemoryPublisher(dataset);
    publishMemory(3, 7);
    expect(target['memory']).toBe('3/7');
    const governor = vi.fn();
    const publishPost = createPostStatePublisher(dataset, governor);
    publishPost(null, null);
    get.mockClear();
    set.mockClear();
    publishMemory(3, 7);
    publishPost(null, diagnostics());
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(governor).toHaveBeenCalledTimes(2);
    publishMemory(4, 7);
    publishMemory(4, 8);
    expect(target['memory']).toBe('4/8');
  });

  it('keeps timestamp resolves single flight and retries after success or failure', async () => {
    let finish: () => void = () => {};
    let fail: (error: unknown) => void = () => {};
    const resolve = vi.fn(() => new Promise<void>((fulfilled, rejected) => {
      finish = fulfilled;
      fail = rejected;
    }));
    const onError = vi.fn();
    const request = createTimestampResolveBridge(resolve, onError);
    request();
    request();
    expect(resolve).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
    request();
    expect(resolve).toHaveBeenCalledTimes(2);
    const error = new Error('query failed');
    fail(error);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(error);
    request();
    expect(resolve).toHaveBeenCalledTimes(3);
    finish();
    await Promise.resolve();
  });

  it('serializes the history of the first live record whatever its version', () => {
    const dataset: DOMStringMap = {};
    const publish = createGovernorPublisher(dataset);
    const events: GovernorDiagnostics['events'] = [{
      direction: 'down', from: 'full', to: 'no-ssr', p95Ms: 20, budgetMs: 16.7,
      atMs: 100, reason: 'over budget',
    }];
    publish(diagnostics({ historyVersion: 0, events }));
    expect(dataset['governorLog']).toBe(JSON.stringify(events));
  });

  it('writes each dataset attribute only when its value changes', () => {
    const target: DOMStringMap = {};
    const get = vi.fn((object: DOMStringMap, key: string) => object[key]);
    const set = vi.fn((object: DOMStringMap, key: string, value: string) => {
      object[key] = value;
      return true;
    });
    const dataset = new Proxy(target, { get, set });
    const publishGovernor = createGovernorPublisher(dataset);
    const publishPost = createPostStatePublisher(dataset, publishGovernor);
    const events: GovernorDiagnostics['events'] = [{
      direction: 'down', from: 'full', to: 'no-ssr', p95Ms: 20, budgetMs: 16.7,
      atMs: 100, reason: 'over budget',
    }];
    const live = diagnostics({ historyVersion: 3, events });
    const features: PostChain['features'] = {
      ao: true, traa: false, msaa: false, ssgi: 'off', ssr: false,
      bloom: false, lut: true, vignette: false, dof: 'off',
    };
    publishPost(features, live);
    // The same record and a fresh record of equal content: no attribute is rewritten.
    publishPost(features, live);
    publishPost({ ...features }, live);
    publishGovernor(null);
    publishGovernor(null);
    publishPost(null, null);
    publishPost(null, null);
    const keys = set.mock.calls.map((call) => call[1]);
    expect(keys).toEqual(['post', 'governor', 'governorLog', 'governor', 'governorLog', 'post']);
  });
});
