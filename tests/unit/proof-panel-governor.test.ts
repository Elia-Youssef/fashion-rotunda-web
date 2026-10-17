// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mountProofPanel } from '../../src/proof/panel';
import type { ProofSnapshot } from '../../src/proof/marks';
import { rowText, sampleSnapshot } from '../support/proof-panel';

// The governor rows: the live level string, the change log rendered from its raw JSON only when
// that input changes, and the honest answers for a disabled governor, an absent log and an
// unreadable one.

describe('mountProofPanel', () => {
  it('parses governor history only when its raw input changes, including invalid input', () => {
    const root = document.createElement('div');
    let snap = sampleSnapshot();
    const parse = vi.spyOn(JSON, 'parse');
    const handle = mountProofPanel(root, { read: () => snap, measure: async () => {} });
    const count = (raw: string): number => parse.mock.calls.filter(([value]) => value === raw).length;
    handle.refresh();
    expect(count(snap.governorLog!)).toBe(1);
    snap = { ...snap, governorLog: 'broken' };
    handle.refresh();
    handle.refresh();
    expect(count('broken')).toBe(1);
    expect(root.textContent).toContain('unreadable governor log');
    snap = { ...snap, governorLog: '[{}]' };
    handle.refresh();
    handle.refresh();
    expect(count('[{}]')).toBe(1);
    expect(root.textContent).toContain('unreadable governor log');
    snap = { ...snap, governorLog: '[]' };
    handle.refresh();
    expect(root.textContent).toContain('no changes yet');
    snap = { ...snap, governorLog: sampleSnapshot().governorLog! };
    handle.refresh();
    expect(count(snap.governorLog!)).toBe(2);
    expect(root.textContent).toContain('down full \u2192 ssgi-half');
    handle.dispose();
  });

  // Matrix 27: the panel rows and the snapshot fields display the same committed governor
  // record, bridged through the canvas attributes the composition root publishes.
  it('renders the disabled governor and an empty log honestly', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn((): ProofSnapshot => ({
      ...sampleSnapshot(),
      governor: 'off',
      governorLog: '',
    }));
    const handle = mountProofPanel(root, { read, measure: async () => {} });
    const text = root.querySelector('section.proof-panel')?.textContent ?? '';
    expect(text).toContain('off');
    expect(text).toContain('no changes yet');

    handle.dispose();
    root.remove();
  });

  it('renders an unreadable log as unreadable rather than inventing entries', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn((): ProofSnapshot => ({
      ...sampleSnapshot(),
      governorLog: 'not json',
    }));
    const handle = mountProofPanel(root, { read, measure: async () => {} });
    const text = root.querySelector('section.proof-panel')?.textContent ?? '';
    expect(text).toContain('unreadable governor log');

    handle.dispose();
    root.remove();
  });

  it.each([
    ['off', 'no changes yet'],
    ['"noise"', 'no changes yet'],
    ['[{"direction":"sideways","from":"full","to":"base","reason":"ok"}]', 'unreadable governor log'],
    ['[{"direction":"down","from":5,"to":"base","reason":"ok"}]', 'unreadable governor log'],
    ['[{"direction":"down","from":"full","to":7,"reason":"ok"}]', 'unreadable governor log'],
    ['[{"direction":"down","from":"full","to":"base","reason":9}]', 'unreadable governor log'],
  ] as const)('renders the governor log %s as %s', (raw, expected) => {
    const root = document.createElement('div');
    const handle = mountProofPanel(root, {
      read: () => ({ ...sampleSnapshot(), governorLog: raw }),
      measure: async () => {},
    });
    expect(rowText(root, 'governor log')).toBe(expected);
    handle.dispose();
  });

  it('joins every governor log entry into one row in order', () => {
    const root = document.createElement('div');
    const handle = mountProofPanel(root, { read: sampleSnapshot, measure: async () => {} });
    expect(rowText(root, 'governor log')).toBe(
      'down full \u2192 ssgi-half; p95 19.4 ms > 16.7 ms | ' +
      'up no-ssgi \u2192 ssgi-half; p95 12.7 ms <= 13.36 ms after 10.0 s',
    );
    handle.dispose();
  });

  it('shows the governor off and a quiet log when the snapshot omits both fields', () => {
    const root = document.createElement('div');
    const bare = (): ProofSnapshot => {
      const snapshot = sampleSnapshot();
      delete snapshot.governor;
      delete snapshot.governorLog;
      return snapshot;
    };
    let snap: ProofSnapshot = bare();
    const handle = mountProofPanel(root, { read: () => snap, measure: async () => {}, intervalMs: 10_000 });
    expect(rowText(root, 'governor')).toBe('off');
    expect(rowText(root, 'governor log')).toBe('no changes yet');
    snap = { ...bare(), governorLog: '' };
    handle.refresh();
    expect(rowText(root, 'governor')).toBe('off');
    expect(rowText(root, 'governor log')).toBe('no changes yet');
    // Back to an absent log after a present one: absent is quiet again, never an error.
    snap = bare();
    handle.refresh();
    expect(rowText(root, 'governor log')).toBe('no changes yet');
    handle.dispose();
  });
});
