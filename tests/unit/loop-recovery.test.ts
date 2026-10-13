import { describe, expect, it } from 'vitest';
import { RecoveryEligibility, recoveryEligible } from '../../src/loop/recovery';

type Facts = [boolean, boolean, boolean, boolean, boolean, boolean];

const factNames = [
  'content on screen',
  'tier settled',
  'reveal settled',
  'page active',
  'document visible',
  'no renderer error',
];

describe('recoveryEligible', () => {
  it('is true when all six facts hold', () => {
    expect(recoveryEligible(true, true, true, true, true, true)).toBe(true);
  });

  it.each(factNames.map((name, index) => ({ name, index })))(
    'is false when $name is the only missing fact',
    ({ index }) => {
      const facts: Facts = [true, true, true, true, true, true];
      facts[index] = false;
      expect(recoveryEligible(...facts)).toBe(false);
    },
  );
});

describe('RecoveryEligibility', () => {
  it.each<{ name: string; facts: readonly [boolean, boolean, boolean, boolean] }>([
    { name: 'content', facts: [false, true, true, true] as const },
    { name: 'tier', facts: [true, false, true, true] as const },
    { name: 'reveal', facts: [true, true, false, true] as const },
  ])('forwards the current $name readiness', ({ facts }) => {
    const recovery = new RecoveryEligibility();
    expect(recovery.eligible(true, true, true, true)).toBe(true);
    expect(recovery.eligible(...facts)).toBe(false);
    expect(recovery.eligible(true, true, true, true)).toBe(true);
  });

  it('ends eligibility while the document is hidden and restores it only when visible', () => {
    const recovery = new RecoveryEligibility();
    expect(recovery.eligible(true, true, true, true)).toBe(true);
    expect(recovery.eligible(true, true, true, false)).toBe(false);
    expect(recovery.eligible(true, true, true, false)).toBe(false);
    expect(recovery.eligible(true, true, true, true)).toBe(true);
  });

  it('ends eligibility on pagehide until pageshow even when the document is visible', () => {
    const recovery = new RecoveryEligibility();
    expect(recovery.eligible(true, true, true, true)).toBe(true);
    recovery.pageActive = false;
    expect(recovery.eligible(true, true, true, true)).toBe(false);
    expect(recovery.eligible(true, true, true, false)).toBe(false);
    expect(recovery.eligible(true, true, true, true)).toBe(false);
    recovery.pageActive = true;
    expect(recovery.eligible(true, true, true, false)).toBe(false);
    expect(recovery.eligible(true, true, true, true)).toBe(true);
  });

  it('never requalifies after a renderer error, including after page and visibility restoration', () => {
    const recovery = new RecoveryEligibility();
    recovery.setRendererError(false);
    expect(recovery.eligible(true, true, true, true)).toBe(true);
    recovery.setRendererError(true);
    expect(recovery.eligible(true, true, true, true)).toBe(false);
    recovery.setRendererError(false);
    expect(recovery.eligible(true, true, true, true)).toBe(false);
    recovery.pageActive = false;
    expect(recovery.eligible(true, true, true, false)).toBe(false);
    recovery.pageActive = true;
    recovery.setRendererError(false);
    expect(recovery.eligible(true, true, true, true)).toBe(false);
  });
});
