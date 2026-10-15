// The frame-time governor. Pure, no three.js, so the p95 window, the
// patience, the ladder, the cooldown and the recovery rule are testable in node.
//
// The governor steps enhanced post-processing down when the measured frame work time repeatedly
// misses the tier budget, and steps it back up one level when the frame work time has stayed
// comfortably inside the budget for a continuous, eligible ten seconds. Both directions
// change exactly one ladder step and start a cooldown, so the level can never oscillate quickly.
//
// The measured input is the render callback's own duration (CPU render-work time, loop.ts
// onFrameTime), the same input the one-way governor used. It is not GPU timestamp time.
//
// At the base level, the post chain keeps LUT and vignette (a single 3D texture lookup and math pass)
// while dropping heavy passes (SSGI, SSR) as well as bloom and depth of field.

import { info } from '../log';

export type EnhancedLevel = 'full' | 'ssgi-half' | 'no-ssgi' | 'no-ssr' | 'base';

/** p95 must sit at or below this share of the tier frame budget for a window to count as comfortable. */
export const RECOVERY_THRESHOLD_RATIO = 0.8;
/** Continuous eligible comfortably-under-budget sampling required before one recovery step. */
export const RECOVERY_QUALIFICATION_MS = 10_000;
/** No level change at all is allowed for this long after every downgrade or recovery. */
export const LEVEL_CHANGE_COOLDOWN_MS = 10_000;
/** An eligible-sample gap longer than this breaks the recovery qualification run. */
export const RECOVERY_MAX_SAMPLE_GAP_MS = 500;
/** The governor-owned change log is capped; the oldest entry is dropped first. */
export const GOVERNOR_EVENT_LOG_CAP = 8;
// Each history snapshot has a distinct version, including a newly restored governor's first snapshot.
let nextHistoryVersion = 0;

export interface GovernorOptions {
  budgetMs: number;
  windowFrames: number;
  /** Consecutive windows over budget before stepping down; 2. */
  patience: number;
  /**
   * False when the active graph has SSR but no SSGI. The shorter ladder then avoids consuming a
   * cooldown on the otherwise no-op `full` -> `ssgi-half` transition. Omitted preserves the
   * full SSGI + SSR ladder used by the established High profile.
   */
  ssgiEnabled?: boolean;
  /**
   * Snapshot carried across an internal post-graph rebuild. It preserves the level, the incomplete
   * p95/patience window, the cooldown and the recovery qualification; a resize must not make the
   * governor start over.
   */
  initialState?: GovernorState;
}

/** One committed level change, as the proof panel and the evidence log read it. */
export interface GovernorEvent {
  direction: 'down' | 'up';
  from: EnhancedLevel;
  to: EnhancedLevel;
  /** p95 of the completed window that produced the decision, in milliseconds. */
  p95Ms: number;
  /** The frame budget that was active for the decision, in milliseconds. */
  budgetMs: number;
  /** Monotonic decision timestamp on the same clock the samples carry. */
  atMs: number;
  /** Human-readable cause, e.g. "p95 19.4 ms > 16.7 ms" or "p95 12.7 ms <= 13.36 ms after 10.0 s". */
  reason: string;
}

/** Complete governor state required to continue an in-progress decision after a graph rebuild. */
export interface GovernorState {
  level: EnhancedLevel;
  samples: readonly number[];
  consecutiveOverBudget: number;
  /** Absolute monotonic time the cooldown ends at; 0 when no cooldown is active. */
  cooldownUntilMs: number;
  /** Absolute monotonic time the current recovery qualification run started; null when not qualifying. */
  recoveryStartedAtMs: number | null;
  /** Absolute monotonic time of the last eligible sample; null before the first one. */
  lastEligibleSampleAtMs: number | null;
  /** Whether every sample of the window currently being filled was recovery-eligible. */
  windowAllEligible: boolean;
  /** p95 of the last completed window; null before the first completion. */
  lastP95Ms: number | null;
  /** The last observed sample's clock value; the diagnostics' default reading time. */
  lastObservedAtMs: number;
  /** Whether the last observed sample's stream counted toward recovery. */
  lastSampleEligible: boolean;
  /** Bounded, oldest-first change history owned by the governor. */
  events: readonly GovernorEvent[];
}

/** What the proof panel and the e2e diagnostics read; every number is committed state. */
export interface GovernorDiagnostics {
  /** Unique to this immutable history snapshot; changes on a commit or governor replacement. */
  readonly historyVersion: number;
  level: EnhancedLevel;
  /** Whether the last observed sample's stream counted toward recovery. */
  recoveryEligible: boolean;
  activity:
    | 'observing'
    | 'downgrade-patience'
    | 'recovery-qualifying'
    | 'cooldown'
    | 'fallback';
  /** Consecutive over-budget complete windows so far. */
  consecutiveOverBudget: number;
  /** The patience threshold, 2, repeated so a reader does not need the options. */
  patience: number;
  cooldownRemainingMs: number;
  /** Elapsed qualification of the current recovery run; 0 when no run is active. */
  recoveryElapsedMs: number;
  recoveryQualificationMs: number;
  recoveryThresholdMs: number;
  budgetMs: number;
  lastP95Ms: number | null;
  events: readonly GovernorEvent[];
}

export interface Governor {
  /**
   * Feeds one frame's work time on the monotonic clock the caller standardises on
   * (performance.now() in production), with whether this sample's stream counts toward
   * recovery; returns the level after the frame.
   */
  observe(workMs: number, nowMs: number, recoveryEligible: boolean): EnhancedLevel;
  readonly level: EnhancedLevel;
  /** The order the levels degrade in, and recover through one step at a time. */
  readonly ladder: readonly EnhancedLevel[];
  /** A defensive snapshot for an internal post-chain rebuild. */
  readonly state: GovernorState;
  /**
   * Borrowed, read-only scalar view; read immediately or spread to retain a snapshot.
   * nowMs defaults to the last observed sample's time. History is an immutable snapshot.
   */
  diagnostics(nowMs?: number): GovernorDiagnostics;
  /**
   * Invalidates the recovery measurement stream when lifecycle eligibility is lost. It preserves
   * committed level/cooldown/history and completed downgrade patience, but discards an in-flight
   * window so pre-interruption samples can never contribute to a later recovery decision.
   */
  invalidateRecovery(): void;
  /**
   * Empties the measurement state the stream owns - the partial window, the downgrade patience,
   * the recovery run and the sample clock - without touching the level, the cooldown or history. The
   * deterministic test harness calls this when it takes over the sample stream, so readings
   * observed on the page's real clock cannot leak into the injected timeline.
   */
  resetSamplingState(): void;
}

const SSGI_LADDER: readonly EnhancedLevel[] = ['full', 'ssgi-half', 'no-ssgi', 'no-ssr', 'base'];
const SSR_ONLY_LADDER: readonly EnhancedLevel[] = ['full', 'no-ssr', 'base'];

/**
 * Computes nearest-rank 95th percentile by sorting the window in place. The governor owns the
 * window and clears it right after this read on the only call path, so no reader sees the
 * disturbed order and the once-per-window completion stays copy-free. Nearest-rank matches
 * FrameTimes.percentile: rank = ceil(0.95 * n), clamped to [1, n].
 */
function calculateP95(window: number[]): number {
  if (window.length === 0) {
    return 0;
  }
  window.sort((a, b) => a - b);
  const rank = Math.min(window.length, Math.max(1, Math.ceil((95 * window.length) / 100)));
  return window[rank - 1];
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function levelIndex(level: EnhancedLevel, ladder: readonly EnhancedLevel[]): number {
  return ladder.indexOf(level);
}

/** Restoration fails closed: one impossible field rejects the whole snapshot. */
function validateState(
  state: GovernorState,
  windowFrames: number,
  ladder: readonly EnhancedLevel[],
): void {
  if (!ladder.includes(state.level)) {
    throw new Error(`unknown governor level: ${state.level}`);
  }
  if (
    state.samples.length >= windowFrames ||
    state.samples.some((sample) => !isFiniteNonNegative(sample))
  ) {
    throw new Error('invalid governor sample window');
  }
  if (!Number.isInteger(state.consecutiveOverBudget) || state.consecutiveOverBudget < 0) {
    throw new Error('invalid governor patience state');
  }
  if (!isFiniteNonNegative(state.cooldownUntilMs)) {
    throw new Error('invalid governor cooldown state');
  }
  if (state.recoveryStartedAtMs !== null && !isFiniteNonNegative(state.recoveryStartedAtMs)) {
    throw new Error('invalid governor recovery qualification state');
  }
  if (state.lastEligibleSampleAtMs !== null && !isFiniteNonNegative(state.lastEligibleSampleAtMs)) {
    throw new Error('invalid governor recovery sample time');
  }
  if (typeof state.windowAllEligible !== 'boolean') {
    throw new Error('invalid governor window eligibility flag');
  }
  if (state.lastP95Ms !== null && !isFiniteNonNegative(state.lastP95Ms)) {
    throw new Error('invalid governor p95 reading');
  }
  if (!isFiniteNonNegative(state.lastObservedAtMs)) {
    throw new Error('invalid governor observation clock');
  }
  if (
    state.recoveryStartedAtMs !== null &&
    (state.lastEligibleSampleAtMs === null ||
      !state.lastSampleEligible ||
      !state.windowAllEligible ||
      state.recoveryStartedAtMs > state.lastEligibleSampleAtMs)
  ) {
    throw new Error('invalid governor recovery clock ordering');
  }
  if (
    state.lastEligibleSampleAtMs !== null &&
    state.lastEligibleSampleAtMs > state.lastObservedAtMs
  ) {
    throw new Error('invalid governor eligible sample ordering');
  }
  if (typeof state.lastSampleEligible !== 'boolean') {
    throw new Error('invalid governor eligibility reading');
  }
  if (
    state.lastSampleEligible &&
    state.lastEligibleSampleAtMs !== state.lastObservedAtMs
  ) {
    throw new Error('invalid governor current eligibility clock');
  }
  if (!Array.isArray(state.events) || state.events.length > GOVERNOR_EVENT_LOG_CAP) {
    throw new Error('invalid governor event history');
  }
  for (const event of state.events) {
    if (event.direction !== 'down' && event.direction !== 'up') {
      throw new Error('invalid governor event direction');
    }
    if (!ladder.includes(event.from) || !ladder.includes(event.to)) {
      throw new Error('invalid governor event level');
    }
    if (
      levelIndex(event.to, ladder) - levelIndex(event.from, ladder) !==
      (event.direction === 'down' ? 1 : -1)
    ) {
      throw new Error('invalid governor event transition');
    }
    if (
      !isFiniteNonNegative(event.p95Ms) ||
      !isFiniteNonNegative(event.budgetMs) ||
      !isFiniteNonNegative(event.atMs) ||
      typeof event.reason !== 'string' ||
      event.reason.length === 0
    ) {
      throw new Error('invalid governor event reading');
    }
  }
}

/**
 * Whether a governor exists at all for this page. Only the normal enhanced WebGPU path runs one:
 * the WebGL 2 backend, the pass-through fallback and every forced development `?post=` slice have
 * no governor, so they can neither degrade nor recover. Pure so the rule is unit-testable and the
 * chain reads it instead of carrying a second copy.
 */
export function governorOperates(
  backend: 'webgpu' | 'webgl2',
  heavy: { ssgi: 'off' | 'full-with-half-fallback'; ssr: boolean },
  forcedSlice: boolean,
): boolean {
  return backend === 'webgpu' && !forcedSlice && (heavy.ssgi !== 'off' || heavy.ssr);
}

export function createGovernor(options: GovernorOptions): Governor {
  const { budgetMs, windowFrames, patience, initialState } = options;
  const ladder = options.ssgiEnabled === false ? SSR_ONLY_LADDER : SSGI_LADDER;
  const recoveryThresholdMs = budgetMs * RECOVERY_THRESHOLD_RATIO;
  if (initialState !== undefined) {
    validateState(initialState, windowFrames, ladder);
  }
  const samples = initialState === undefined ? [] : [...initialState.samples];
  let currentIndex = initialState === undefined ? 0 : levelIndex(initialState.level, ladder);
  let consecutiveOverBudget = initialState?.consecutiveOverBudget ?? 0;
  let cooldownUntilMs = initialState?.cooldownUntilMs ?? 0;
  let recoveryStartedAtMs = initialState?.recoveryStartedAtMs ?? null;
  let lastEligibleSampleAtMs = initialState?.lastEligibleSampleAtMs ?? null;
  let windowAllEligible = initialState?.windowAllEligible ?? true;
  let lastP95Ms = initialState?.lastP95Ms ?? null;
  let lastEligible = initialState?.lastSampleEligible ?? false;
  let lastObservedAtMs = initialState?.lastObservedAtMs ?? 0;
  const events: GovernorEvent[] = initialState === undefined
    ? []
    : initialState.events.map((event) => Object.freeze({ ...event }));
  let historyVersion = nextHistoryVersion++;
  let history: readonly GovernorEvent[] = Object.freeze([...events]);
  let diagnosticsAtMs = lastObservedAtMs;
  const readings: GovernorDiagnostics = Object.freeze({
    get historyVersion() { return historyVersion; },
    get level() { return ladder[currentIndex]; },
    get recoveryEligible() { return lastEligible; },
    get activity(): GovernorDiagnostics['activity'] {
      if (readings.cooldownRemainingMs > 0) return 'cooldown';
      if (consecutiveOverBudget > 0) return 'downgrade-patience';
      if (recoveryStartedAtMs !== null) return 'recovery-qualifying';
      return 'observing';
    },
    get consecutiveOverBudget() { return consecutiveOverBudget; },
    patience,
    get cooldownRemainingMs() { return Math.max(0, cooldownUntilMs - diagnosticsAtMs); },
    get recoveryElapsedMs() {
      return recoveryStartedAtMs === null ? 0 : Math.max(0, diagnosticsAtMs - recoveryStartedAtMs);
    },
    recoveryQualificationMs: RECOVERY_QUALIFICATION_MS,
    recoveryThresholdMs,
    budgetMs,
    get lastP95Ms() { return lastP95Ms; },
    get events() { return history; },
  });

  function pushEvent(event: GovernorEvent): void {
    events.push(Object.freeze(event));
    // One push at a time can exceed the cap by only one entry, so the oldest leaves through shift,
    // which returns the dropped entry, instead of splice, which would build a removed-elements
    // array only for the caller to discard it.
    if (events.length > GOVERNOR_EVENT_LOG_CAP) {
      events.shift();
    }
    history = Object.freeze([...events]);
    historyVersion = nextHistoryVersion++;
  }

  /** Exactly one ladder step, plus every reset and cooldown the change implies. */
  function changeLevel(
    direction: 'down' | 'up',
    p95: number,
    nowMs: number,
    reason: string,
  ): void {
    const from = ladder[currentIndex];
    currentIndex += direction === 'down' ? 1 : -1;
    samples.length = 0;
    consecutiveOverBudget = 0;
    recoveryStartedAtMs = null;
    windowAllEligible = true;
    cooldownUntilMs = nowMs + LEVEL_CHANGE_COOLDOWN_MS;
    pushEvent({ direction, from, to: ladder[currentIndex], p95Ms: p95, budgetMs, atMs: nowMs, reason });
  }

  return {
    observe(workMs: number, nowMs: number, recoveryEligible: boolean): EnhancedLevel {
      // A non-finite reading is a measurement defect, not a performance signal; dropping the
      // sample keeps NaN, negative durations and a non-monotonic clock from poisoning a whole
      // window's p95 or counting elapsed recovery time in either direction.
      if (
        !isFiniteNonNegative(workMs) ||
        !isFiniteNonNegative(nowMs) ||
        nowMs < lastObservedAtMs
      ) {
        // A defective observation makes the current measurement window incomplete. Fail closed:
        // it cannot contribute samples or elapsed time to a later recovery decision.
        samples.length = 0;
        recoveryStartedAtMs = null;
        lastEligibleSampleAtMs = null;
        windowAllEligible = true;
        lastEligible = false;
        return ladder[currentIndex];
      }
      lastObservedAtMs = nowMs;
      lastEligible = recoveryEligible;

      // The recovery stream is made of eligible samples no more than 500 ms apart; anything
      // else clears the accumulated qualification, and time with no samples never counts.
      if (recoveryEligible) {
        const gapBroken =
          lastEligibleSampleAtMs !== null && nowMs - lastEligibleSampleAtMs > RECOVERY_MAX_SAMPLE_GAP_MS;
        if (recoveryStartedAtMs === null || gapBroken) {
          recoveryStartedAtMs = nowMs;
        }
        lastEligibleSampleAtMs = nowMs;
      } else {
        recoveryStartedAtMs = null;
      }
      windowAllEligible = windowAllEligible && recoveryEligible;

      samples.push(workMs);
      if (samples.length >= windowFrames) {
        // A partial window never decides anything; only this completion does.
        const p95 = calculateP95(samples);
        samples.length = 0;
        // The flag describes the window that just completed; the next one starts eligible until
        // one of its own samples says otherwise.
        const completedWindowEligible = windowAllEligible;
        windowAllEligible = true;
        lastP95Ms = p95;
        const cooldownActive = nowMs < cooldownUntilMs;

        if (p95 > budgetMs) {
          // Over budget: recovery qualification is gone, downgrade patience grows.
          recoveryStartedAtMs = null;
          consecutiveOverBudget += 1;
          if (consecutiveOverBudget >= patience) {
            if (!cooldownActive && currentIndex < ladder.length - 1) {
              changeLevel(
                'down',
                p95,
                nowMs,
                `p95 ${p95.toFixed(1)} ms > ${budgetMs.toFixed(1)} ms`,
              );
              info(
                `[archviz] post governor stepped down to ${ladder[currentIndex]} (p95 was ${p95.toFixed(1)} ms)`,
              );
            } else if (!cooldownActive) {
              // The decision point was reached but the ladder is exhausted at base.
              consecutiveOverBudget = 0;
            }
          }
        } else if (p95 <= recoveryThresholdMs) {
          // Comfortably under budget: downgrade patience resets; recovery may complete here.
          consecutiveOverBudget = 0;
          const qualified =
            recoveryStartedAtMs !== null &&
            nowMs - recoveryStartedAtMs >= RECOVERY_QUALIFICATION_MS;
          if (
            !cooldownActive &&
            currentIndex > 0 &&
            completedWindowEligible &&
            qualified
          ) {
            const qualifiedFor = nowMs - (recoveryStartedAtMs as number);
            changeLevel(
              'up',
              p95,
              nowMs,
              `p95 ${p95.toFixed(1)} ms <= ${recoveryThresholdMs.toFixed(2)} ms after ${(qualifiedFor / 1000).toFixed(1)} s`,
            );
            info(
              `[archviz] post governor recovered to ${ladder[currentIndex]} (p95 was ${p95.toFixed(1)} ms)`,
            );
          }
        } else {
          // Borderline: no change, and both qualification counters start over.
          consecutiveOverBudget = 0;
          recoveryStartedAtMs = null;
        }
      }
      return ladder[currentIndex];
    },

    get level(): EnhancedLevel {
      return ladder[currentIndex];
    },

    get ladder(): readonly EnhancedLevel[] {
      return ladder;
    },

    get state(): GovernorState {
      return {
        level: ladder[currentIndex],
        samples: [...samples],
        consecutiveOverBudget,
        cooldownUntilMs,
        recoveryStartedAtMs,
        lastEligibleSampleAtMs,
        windowAllEligible,
        lastP95Ms,
        lastObservedAtMs,
        lastSampleEligible: lastEligible,
        events: events.map((event) => ({ ...event })),
      };
    },

    diagnostics(nowMs?: number): GovernorDiagnostics {
      diagnosticsAtMs = nowMs ?? lastObservedAtMs;
      return readings;
    },

    invalidateRecovery(): void {
      // A lifecycle interruption cannot leave a half-filled p95 window behind: even if the
      // following samples are healthy, the first later decision must be based entirely on the
      // resumed stream. Completed downgrade patience is intentionally retained.
      samples.length = 0;
      recoveryStartedAtMs = null;
      lastEligibleSampleAtMs = null;
      windowAllEligible = true;
      lastEligible = false;
    },

    resetSamplingState(): void {
      samples.length = 0;
      consecutiveOverBudget = 0;
      recoveryStartedAtMs = null;
      lastEligibleSampleAtMs = null;
      windowAllEligible = true;
      lastEligible = false;
      lastObservedAtMs = 0;
    },
  };
}
