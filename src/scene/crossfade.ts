// The cross-fade between two looks. The arithmetic and the transitions both
// live here, in a module with no three.js import, so the whole machine runs under node. The
// showroom owns the materials, the meshes and the GPU resources; this module owns which
// transition happens when, and calls back into the showroom to make each one happen.

/** One running fade: how long it has run and how long it runs in total. */
export interface FadeState {
  elapsedMs: number;
  durationMs: number;
}

/** The fade's length in milliseconds; prefers-reduced-motion replaces it with 0 at the caller. */
export const CROSSFADE_MS = 600;

/**
 * The loop's dt is the time since the last drawn frame, idle time included: a page that sat still
 * for a minute would otherwise hand the fade's first frame the whole gap and finish it at once.
 * One frame's worth at most may advance the fade, the same clamp the camera mount uses.
 */
export const MAX_FADE_STEP_MS = 100;

/**
 * The progress at which the sun's one caster changes hands. A shadow pass draws every caster
 * through one shared override material, so no opacity of ours reaches it and a caster can only be
 * on or off: the outgoing look holds the shadow over the first half of the fade, the incoming look
 * over the second, which is the half where it is already the more solid of the two on screen.
 */
export const SHADOW_HANDOVER = 0.5;

/** 0 at the start, 1 at the end, clamped; a duration of 0 is complete at once. */
export function fadeProgress(state: FadeState): number {
  if (state.durationMs <= 0) {
    return 1;
  }
  return Math.min(Math.max(state.elapsedMs / state.durationMs, 0), 1);
}

/**
 * The outgoing and incoming opacities for a progress value.
 *
 * The incoming look is opaque for the whole fade and the outgoing look dissolves over it. Two
 * see-through layers at once is what lets the room show through both looks where neither happens
 * to cover a pixel, and an opaque backdrop is what makes the outgoing look's dissolve reveal the
 * incoming look instead. The clamps keep a caller's out-of-range progress from driving an opacity
 * below 0 or above 1.
 */
export function fadeOpacities(progress: number): { outgoing: number; incoming: number } {
  const clamped = Math.min(Math.max(progress, 0), 1);
  return { outgoing: 1 - clamped, incoming: 1 };
}

/**
 * What the machine needs the caller to do. Each one is a side effect on three.js objects the
 * showroom owns, which is exactly what keeps this module free of three.js.
 */
export interface FadeCallbacks<T> {
  /** Puts the dissolve shader on a look (`on`) or restores its opaque materials (`off`). */
  dissolve(look: T, on: boolean): void;
  /** Writes one look's opacity: one uniform value, no material rebuild. */
  opacity(look: T, value: number): void;
  /** Whether the look casts the sun's shadow; false parks it, true gives back what it was given. */
  casting(look: T, on: boolean): void;
  /** Frees a look's GPU resources. Called exactly once per look, when its own fade ends. */
  dispose(look: T): void;
  /** The first advance of a fade, where the caller closes its switch measure. */
  firstFrame(): void;
  /** A fade ended. A caller that starts another one in the same run re-checks `running`. */
  settled(): void;
}

export interface FadeMachine<T> {
  /**
   * Starts a fade from `outgoing` to `incoming`. A fade already running ends first, which is how a
   * click that lands mid-fade never stacks a third look: its outgoing look is disposed on the
   * spot, its incoming look is left opaque, and the new fade starts from that state.
   */
  start(outgoing: T, incoming: T, durationMs: number): void;
  /** Advances a running fade by one frame's dt, clamped; does nothing when none runs. */
  advance(dtMs: number): void;
  /** Ends a running fade at once: the incoming look opaque, the outgoing look disposed. */
  finish(): void;
  readonly running: boolean;
  /** The look fading out, or null when no fade runs; the caller turns it with the incoming one. */
  readonly outgoing: T | null;
}

/** One fade in flight, plus the two once-only transitions that have to fire on an inner frame. */
interface RunningFade<T> {
  outgoing: T;
  incoming: T;
  state: FadeState;
  measured: boolean;
  handedOver: boolean;
}

export function createFadeMachine<T>(callbacks: FadeCallbacks<T>): FadeMachine<T> {
  let current: RunningFade<T> | null = null;

  function applyOpacities(running: RunningFade<T>): void {
    const { outgoing, incoming } = fadeOpacities(fadeProgress(running.state));
    callbacks.opacity(running.outgoing, outgoing);
    callbacks.opacity(running.incoming, incoming);
  }

  function finish(): void {
    const running = current;
    if (running === null) {
      return;
    }
    // Cleared before the callbacks run, so a caller that reads `running` from inside one of them
    // sees the fade as over rather than as still in flight.
    current = null;
    callbacks.opacity(running.incoming, 1);
    callbacks.casting(running.incoming, true);
    // Restored before the disposal: the materials of a look are its own here, but a restore that
    // depends on the disposal order is the kind that stops being true when the loader changes.
    callbacks.dissolve(running.outgoing, false);
    callbacks.dispose(running.outgoing);
    callbacks.settled();
  }

  return {
    start(outgoing: T, incoming: T, durationMs: number): void {
      finish();
      const running: RunningFade<T> = {
        outgoing,
        incoming,
        state: { elapsedMs: 0, durationMs },
        measured: false,
        handedOver: false,
      };
      current = running;
      callbacks.dissolve(outgoing, true);
      // One caster per frame: the outgoing look still holds the sun until the handover.
      callbacks.casting(incoming, false);
      applyOpacities(running);
    },

    advance(dtMs: number): void {
      const running = current;
      if (running === null) {
        return;
      }
      running.state.elapsedMs += Math.min(Math.max(dtMs, 0), MAX_FADE_STEP_MS);
      if (!running.measured) {
        running.measured = true;
        callbacks.firstFrame();
      }
      const progress = fadeProgress(running.state);
      if (!running.handedOver && progress >= SHADOW_HANDOVER) {
        running.handedOver = true;
        callbacks.casting(running.incoming, true);
        callbacks.casting(running.outgoing, false);
      }
      applyOpacities(running);
      if (progress >= 1) {
        finish();
      }
    },

    finish,

    get running(): boolean {
      return current !== null;
    },

    get outgoing(): T | null {
      return current === null ? null : current.outgoing;
    },
  };
}
