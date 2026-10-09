import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createGovernor, GOVERNOR_EVENT_LOG_CAP, RECOVERY_QUALIFICATION_MS } from '../../src/post/governor';
import type { Governor, GovernorDiagnostics, GovernorState } from '../../src/post/governor';

// Execute the production publisher itself without importing the page's renderer and boot side effects.
const source = ts.createSourceFile('main.ts', readFileSync('src/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const publisher = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'createGovernorPublisher');
if (publisher === undefined) throw new Error('missing governor publisher');
const compiled = ts.transpileModule(publisher.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const createPublisher = new Function(`${compiled}\nreturn createGovernorPublisher;`)() as
  (dataset: DOMStringMap) => (diagnostics: GovernorDiagnostics | null) => void;

/** The original formatter, retained verbatim as the text-equivalence oracle. */
function oldStatus(diagnostics: GovernorDiagnostics | null): string {
  if (diagnostics === null) return 'off';
  const p95 = diagnostics.lastP95Ms === null ? 'none' : diagnostics.lastP95Ms.toFixed(1);
  return [
    `level=${diagnostics.level}`,
    `activity=${diagnostics.activity}`,
    `eligible=${diagnostics.recoveryEligible ? '1' : '0'}`,
    `cooldown=${Math.ceil(diagnostics.cooldownRemainingMs)}`,
    `patience=${diagnostics.consecutiveOverBudget}/${diagnostics.patience}`,
    `qualify=${Math.floor(diagnostics.recoveryElapsedMs)}/${diagnostics.recoveryQualificationMs}`,
    `p95=${p95}`,
    `budget=${diagnostics.budgetMs.toFixed(1)}`,
    `threshold=${diagnostics.recoveryThresholdMs.toFixed(2)}`,
  ].join(';');
}

/** The original diagnostic scalar calculation, driven by the committed state snapshot. */
function oldReadings(state: GovernorState, nowMs: number, budgetMs = 16.7): GovernorDiagnostics {
  const cooldownRemainingMs = Math.max(0, state.cooldownUntilMs - nowMs);
  return {
    historyVersion: 0,
    level: state.level,
    recoveryEligible: state.lastSampleEligible,
    activity: cooldownRemainingMs > 0 ? 'cooldown' : state.consecutiveOverBudget > 0
      ? 'downgrade-patience' : state.recoveryStartedAtMs !== null ? 'recovery-qualifying' : 'observing',
    consecutiveOverBudget: state.consecutiveOverBudget,
    patience: 2,
    cooldownRemainingMs,
    recoveryElapsedMs: state.recoveryStartedAtMs === null ? 0 : Math.max(0, nowMs - state.recoveryStartedAtMs),
    recoveryQualificationMs: RECOVERY_QUALIFICATION_MS,
    recoveryThresholdMs: budgetMs * 0.8,
    budgetMs,
    lastP95Ms: state.lastP95Ms,
    events: state.events,
  };
}

function cycle(gov: Governor, clock: number): number {
  // Two over-budget windows step down; eligible half-second sampling completes recovery and cooldown.
  clock += 10_000;
  for (let i = 0; i < 4; i += 1) gov.observe(40.04, clock += 500, false);
  for (let i = 0; i < 24; i += 1) gov.observe(8.06, clock += 500, true);
  return clock;
}

describe('governor publication', () => {
  it('reuses scalar readings and versions immutable history only on committed changes, including eviction', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const gov = createGovernor({ budgetMs: 16.7, windowFrames: 2, patience: 2 });
      const first = gov.diagnostics();
      const initialHistory = first.events;
      const initialVersion = first.historyVersion;
      gov.observe(8, 500, true);
      expect(gov.diagnostics(501.25)).toBe(first);
      expect(first.recoveryElapsedMs).toBe(1.25);
      expect(first.events).toBe(initialHistory);
      gov.invalidateRecovery(); gov.resetSamplingState();
      expect(gov.diagnostics().historyVersion).toBe(initialVersion);
      let clock = 0;
      let previousHistory = initialHistory;
      let previousVersion = initialVersion;
      for (let i = 0; i < 6; i += 1) {
        clock = cycle(gov, clock);
        const readings = gov.diagnostics();
        expect(readings).toBe(first);
        expect(readings.historyVersion).toBe(previousVersion + 2);
        expect(readings.events).not.toBe(previousHistory);
        expect(readings.events.length).toBe(Math.min((i + 1) * 2, GOVERNOR_EVENT_LOG_CAP));
        expect(Object.isFrozen(readings)).toBe(true);
        expect(Object.isFrozen(readings.events)).toBe(true);
        expect(Object.isFrozen(readings.events[0])).toBe(true);
        const snapshot = gov.state;
        snapshot.events[0].reason = 'changed snapshot';
        expect(readings.events[0].reason).not.toBe('changed snapshot');
        previousHistory = readings.events;
        previousVersion = readings.historyVersion;
      }
      expect(initialHistory).toEqual([]);
      const carried = gov.state;
      const restored = createGovernor({ budgetMs: 16.7, windowFrames: 2, patience: 2, initialState: carried });
      carried.events[0].reason = 'changed input';
      expect(restored.diagnostics().events[0].reason).not.toBe('changed input');
      expect(restored.diagnostics().events).not.toBe(previousHistory);
      expect(restored.diagnostics().historyVersion).not.toBe(previousVersion);
    } finally {
      log.mockRestore();
    }
  });

  it('publishes byte-identical status and history for scripted states, lifecycle changes and rebuilds', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const dataset: DOMStringMap = {};
      const publish = createPublisher(dataset);
      let gov = createGovernor({ budgetMs: 16.7, windowFrames: 2, patience: 2 });
      let clock = 0;
      const activities = new Set<string>();
      const check = (nowMs: number, eligible?: boolean): void => {
        const expected = oldReadings(gov.state, nowMs);
        const actual = { ...gov.diagnostics(nowMs) };
        // The chain overrides eligibility at its external snapshot boundary.
        if (eligible !== undefined) actual.recoveryEligible = expected.recoveryEligible = eligible;
        activities.add(expected.activity);
        publish(actual);
        expect(dataset.governor).toBe(oldStatus(expected));
        expect(dataset.governorLog).toBe(JSON.stringify(expected.events));
        for (const key of Object.keys(expected) as (keyof GovernorDiagnostics)[]) {
          if (key !== 'historyVersion') expect(actual[key], key).toEqual(expected[key]);
        }
      };
      publish(null);
      expect(dataset).toEqual({ governor: 'off', governorLog: '[]' });
      check(clock);
      for (let cycleIndex = 0; cycleIndex < 6; cycleIndex += 1) {
        clock += 10_000;
        for (let i = 0; i < 28; i += 1) {
          gov.observe(i < 4 ? 40.04 : 8.06, clock += 500, i >= 4);
          check(clock + 0.25);
          check(clock + 0.99, false);
          if (i === 8) {
            gov = createGovernor({ budgetMs: 16.7, windowFrames: 2, patience: 2, initialState: gov.state });
            check(clock + 0.25);
          }
        }
      }
      gov.invalidateRecovery(); check(clock);
      gov.observe(NaN, clock += 500, true); check(clock);
      gov.resetSamplingState(); check(0);
      gov.observe(15.055, clock = 500, true); check(clock);
      gov.observe(15.055, clock += 500, true); check(clock);
      publish(null);
      expect(dataset).toEqual({ governor: 'off', governorLog: '[]' });
      check(clock);
      const other = createGovernor({ budgetMs: 20.05, windowFrames: 2, patience: 2 });
      const otherReadings = other.diagnostics();
      publish(otherReadings);
      expect(dataset.governor).toBe(oldStatus(oldReadings(other.state, 0, 20.05)));
      expect(dataset.governorLog).toBe('[]');
      expect([...activities].sort()).toEqual(['cooldown', 'downgrade-patience', 'observing', 'recovery-qualifying']);
    } finally {
      log.mockRestore();
    }
  });

  it('serializes history once per change through repeated frames, cap eviction, off and replacement', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const dataset: DOMStringMap = {};
      const publish = createPublisher(dataset);
      let gov = createGovernor({ budgetMs: 16.7, windowFrames: 2, patience: 2 });
      const counts: number[] = [];
      const repeat = (): void => {
        // Match the chain's per-frame spread, including its current eligibility override.
        for (let i = 0; i < 20; i += 1) publish({ ...gov.diagnostics(), recoveryEligible: i % 2 === 0 });
        counts.push(stringify.mock.calls.length);
      };
      publish(null);
      repeat();
      let clock = 0;
      for (let i = 0; i < 12; i += 1) {
        const version = gov.diagnostics().historyVersion;
        while (gov.diagnostics().historyVersion === version) {
          gov.observe(gov.level === 'full' ? 40 : 8, clock += 500, gov.level !== 'full');
          publish({ ...gov.diagnostics() });
        }
        repeat();
      }
      publish(null); repeat();
      gov = createGovernor({ budgetMs: 16.7, windowFrames: 2, patience: 2, initialState: gov.state });
      repeat();
      // A fresh governor also has a distinct snapshot version, even with an empty history.
      gov = createGovernor({ budgetMs: 16.7, windowFrames: 2, patience: 2 });
      repeat();
      stringify.mockRestore();
      expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 13, 14, 15]);
    } finally {
      stringify.mockRestore();
      log.mockRestore();
    }
  });
});
