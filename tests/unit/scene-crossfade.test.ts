import { beforeEach, describe, expect, it } from 'vitest';
import {
  CROSSFADE_MS,
  MAX_FADE_STEP_MS,
  SHADOW_HANDOVER,
  createFadeMachine,
  fadeOpacities,
  fadeProgress,
} from '../../src/scene/crossfade';
import type { FadeMachine } from '../../src/scene/crossfade';

// G5.1 step 4: the cross-fade. Both halves are here, because both are pure: the arithmetic, and
// the machine that decides which transition happens on which frame. What stays in showroom.ts is
// the three.js side of each callback, which the browser spec covers.

describe('fadeProgress', () => {
  it('is 0 at the start', () => {
    expect(fadeProgress({ elapsedMs: 0, durationMs: CROSSFADE_MS })).toBe(0);
  });

  it('is half way at half the duration', () => {
    expect(fadeProgress({ elapsedMs: 300, durationMs: CROSSFADE_MS })).toBe(0.5);
  });

  it('is 1 at the end', () => {
    expect(fadeProgress({ elapsedMs: CROSSFADE_MS, durationMs: CROSSFADE_MS })).toBe(1);
  });

  it('clamps past the end instead of extrapolating', () => {
    expect(fadeProgress({ elapsedMs: CROSSFADE_MS + 5000, durationMs: CROSSFADE_MS })).toBe(1);
  });

  it('clamps a negative elapsed, which a stray dt sign would produce', () => {
    expect(fadeProgress({ elapsedMs: -50, durationMs: CROSSFADE_MS })).toBe(0);
  });

  it('completes at once when the duration is 0', () => {
    expect(fadeProgress({ elapsedMs: 0, durationMs: 0 })).toBe(1);
  });

  it('completes at once when the duration is negative, the malformed-input twin of 0', () => {
    expect(fadeProgress({ elapsedMs: 0, durationMs: -1 })).toBe(1);
  });
});

describe('fadeOpacities', () => {
  it('keeps the incoming look opaque for the whole fade', () => {
    // Two see-through layers let the room show through both looks where neither covers a pixel.
    // An opaque backdrop is what makes the outgoing look's dissolve reveal the incoming look.
    for (let step = 0; step <= 20; step += 1) {
      expect(fadeOpacities(step / 20).incoming).toBe(1);
    }
  });

  it('shows the outgoing look whole at the start', () => {
    expect(fadeOpacities(0)).toEqual({ outgoing: 1, incoming: 1 });
  });

  it('has the outgoing look gone at the end', () => {
    expect(fadeOpacities(1)).toEqual({ outgoing: 0, incoming: 1 });
  });

  it('halves the outgoing look at the middle', () => {
    expect(fadeOpacities(0.5)).toEqual({ outgoing: 0.5, incoming: 1 });
  });

  it('falls without ever rising, so no frame puts back what a previous frame removed', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let step = 0; step <= 20; step += 1) {
      const { outgoing } = fadeOpacities(step / 20);
      expect(outgoing).toBeLessThanOrEqual(previous);
      previous = outgoing;
    }
  });

  it('clamps an out-of-range progress instead of inverting an opacity', () => {
    expect(fadeOpacities(1.5)).toEqual({ outgoing: 0, incoming: 1 });
    expect(fadeOpacities(-0.5)).toEqual({ outgoing: 1, incoming: 1 });
  });
});

/** One look as the machine sees it: four values it writes and a count of the times it freed it. */
interface FakeLook {
  id: string;
  opacity: number;
  dissolving: boolean;
  casting: boolean;
  disposals: number;
}

function fakeLook(id: string): FakeLook {
  // Casting starts true: a look reaches the machine after the lighting has decorated it.
  return { id, opacity: 1, dissolving: false, casting: true, disposals: 0 };
}

/** The machine plus everything its callbacks did, in order, so a test can read the sequence. */
interface Harness {
  machine: FadeMachine<FakeLook>;
  events: string[];
  counts: { firstFrames: number; settles: number };
}

function harness(): Harness {
  const events: string[] = [];
  const counts = { firstFrames: 0, settles: 0 };
  const machine = createFadeMachine<FakeLook>({
    dissolve: (look, on) => {
      look.dissolving = on;
      events.push(`dissolve ${look.id} ${String(on)}`);
    },
    opacity: (look, value) => {
      look.opacity = value;
    },
    casting: (look, on) => {
      look.casting = on;
      events.push(`casting ${look.id} ${String(on)}`);
    },
    dispose: (look) => {
      look.disposals += 1;
      events.push(`dispose ${look.id}`);
    },
    firstFrame: () => {
      counts.firstFrames += 1;
      events.push('firstFrame');
    },
    settled: () => {
      counts.settles += 1;
      events.push('settled');
    },
  });
  return { machine, events, counts };
}

describe('createFadeMachine', () => {
  let run: Harness;
  let a: FakeLook;
  let b: FakeLook;
  let c: FakeLook;

  beforeEach(() => {
    run = harness();
    a = fakeLook('a');
    b = fakeLook('b');
    c = fakeLook('c');
  });

  it('runs nothing before a fade starts', () => {
    expect(run.machine.running).toBe(false);
    expect(run.machine.outgoing).toBeNull();
    run.machine.advance(16);
    run.machine.finish();
    expect(run.events).toEqual([]);
  });

  it('starts with the outgoing look dissolving over an opaque incoming look', () => {
    run.machine.start(a, b, CROSSFADE_MS);

    expect(run.machine.running).toBe(true);
    expect(run.machine.outgoing).toBe(a);
    expect(a.dissolving).toBe(true);
    expect(b.dissolving).toBe(false);
    expect(a.opacity).toBe(1);
    expect(b.opacity).toBe(1);
    // No frame has been drawn yet, so nothing has been measured and nothing disposed.
    expect(run.counts.firstFrames).toBe(0);
    expect(a.disposals).toBe(0);
  });

  it('hands the one caster over at the halfway mark and not before', () => {
    run.machine.start(a, b, CROSSFADE_MS);
    expect([a.casting, b.casting]).toEqual([true, false]);

    // Just short of the handover: the outgoing look still holds the sun. Every step is within
    // the clamp, so the elapsed time is the sum of the steps.
    run.machine.advance(MAX_FADE_STEP_MS);
    run.machine.advance(MAX_FADE_STEP_MS);
    run.machine.advance(CROSSFADE_MS * SHADOW_HANDOVER - 2 * MAX_FADE_STEP_MS - 1);
    expect([a.casting, b.casting]).toEqual([true, false]);

    run.machine.advance(1);
    expect([a.casting, b.casting]).toEqual([false, true]);
  });

  it('keeps exactly one caster on at every frame of the fade', () => {
    run.machine.start(a, b, CROSSFADE_MS);
    const casters: number[] = [Number(a.casting) + Number(b.casting)];
    for (let frame = 0; frame < 60; frame += 1) {
      run.machine.advance(16);
      casters.push(Number(a.casting) + Number(b.casting));
    }
    expect(new Set(casters)).toEqual(new Set([1]));
  });

  it('advances the outgoing opacity by the frame time and measures the first frame once', () => {
    run.machine.start(a, b, CROSSFADE_MS);

    run.machine.advance(MAX_FADE_STEP_MS);
    expect(a.opacity).toBeCloseTo(1 - MAX_FADE_STEP_MS / CROSSFADE_MS, 10);
    run.machine.advance(MAX_FADE_STEP_MS);
    expect(a.opacity).toBeCloseTo(1 - (2 * MAX_FADE_STEP_MS) / CROSSFADE_MS, 10);

    expect(run.counts.firstFrames).toBe(1);
  });

  it('clamps one frame of dt, so a wake after an idle page does not skip the fade', () => {
    run.machine.start(a, b, CROSSFADE_MS);
    run.machine.advance(60_000);
    expect(run.machine.running).toBe(true);
    expect(a.opacity).toBeCloseTo(1 - MAX_FADE_STEP_MS / CROSSFADE_MS, 10);
  });

  it('ignores a negative dt rather than running the fade backwards', () => {
    run.machine.start(a, b, CROSSFADE_MS);
    run.machine.advance(MAX_FADE_STEP_MS);
    run.machine.advance(-1000);
    expect(a.opacity).toBeCloseTo(1 - MAX_FADE_STEP_MS / CROSSFADE_MS, 10);
  });

  it('ends by restoring the incoming look, freeing the outgoing one and settling', () => {
    run.machine.start(a, b, CROSSFADE_MS);
    for (let frame = 0; frame < 10; frame += 1) {
      run.machine.advance(MAX_FADE_STEP_MS);
    }

    expect(run.machine.running).toBe(false);
    expect(run.machine.outgoing).toBeNull();
    expect(b.opacity).toBe(1);
    expect(b.casting).toBe(true);
    expect(a.dissolving).toBe(false);
    expect(a.disposals).toBe(1);
    expect(run.counts.settles).toBe(1);
    // The restore happens before the disposal, so the order does not depend on what dispose frees.
    expect(run.events.slice(-3)).toEqual(['dissolve a false', 'dispose a', 'settled']);
  });

  it('ends once, whatever a later frame or a stray finish does', () => {
    run.machine.start(a, b, CROSSFADE_MS);
    for (let frame = 0; frame < CROSSFADE_MS / MAX_FADE_STEP_MS; frame += 1) {
      run.machine.advance(MAX_FADE_STEP_MS);
    }
    expect(run.machine.running).toBe(false);

    run.machine.advance(16);
    run.machine.finish();

    expect(a.disposals).toBe(1);
    expect(run.counts.settles).toBe(1);
    expect(run.counts.firstFrames).toBe(1);
  });

  it('completes on its first frame at a duration of 0, the reduced-motion swap', () => {
    run.machine.start(a, b, 0);
    expect(run.machine.running).toBe(true);

    run.machine.advance(16);

    expect(run.machine.running).toBe(false);
    expect(a.disposals).toBe(1);
    expect(a.dissolving).toBe(false);
    expect(b.opacity).toBe(1);
    // The one caster still changes hands, in the same frame rather than half way through.
    expect([a.casting, b.casting]).toEqual([false, true]);
    expect(run.counts.firstFrames).toBe(1);
  });

  it('interrupts a running fade: the old one ends at once and the new one starts from it', () => {
    run.machine.start(a, b, CROSSFADE_MS);
    run.machine.advance(MAX_FADE_STEP_MS);
    expect(a.opacity).toBeCloseTo(1 - MAX_FADE_STEP_MS / CROSSFADE_MS, 10);

    run.machine.start(b, c, CROSSFADE_MS);

    // The interrupted fade ended: its outgoing look freed once, its incoming look whole again.
    expect(a.disposals).toBe(1);
    expect(a.dissolving).toBe(false);
    expect(b.opacity).toBe(1);
    // And the new fade runs from that state, with b now the one dissolving.
    expect(run.machine.running).toBe(true);
    expect(run.machine.outgoing).toBe(b);
    expect(b.dissolving).toBe(true);
    expect(c.dissolving).toBe(false);
    expect([b.casting, c.casting]).toEqual([true, false]);
  });

  it('measures the first frame of the interrupting fade, not of the one it replaced', () => {
    run.machine.start(a, b, CROSSFADE_MS);
    run.machine.advance(MAX_FADE_STEP_MS);
    expect(run.counts.firstFrames).toBe(1);

    run.machine.start(b, c, CROSSFADE_MS);
    run.machine.advance(16);

    expect(run.counts.firstFrames).toBe(2);
  });

  it('stacks no third look: two interrupts free two looks and leave one fading', () => {
    run.machine.start(a, b, CROSSFADE_MS);
    run.machine.advance(16);
    run.machine.start(b, c, CROSSFADE_MS);
    run.machine.advance(16);
    const d = fakeLook('d');
    run.machine.start(c, d, CROSSFADE_MS);

    expect([a.disposals, b.disposals, c.disposals, d.disposals]).toEqual([1, 1, 0, 0]);
    expect(run.machine.outgoing).toBe(c);
    expect([c.casting, d.casting]).toEqual([true, false]);
  });

  it('settles once per fade, so an interrupted fade does not swallow its own signal', () => {
    run.machine.start(a, b, CROSSFADE_MS);
    run.machine.advance(MAX_FADE_STEP_MS);
    run.machine.start(b, c, CROSSFADE_MS);
    for (let frame = 0; frame < CROSSFADE_MS / MAX_FADE_STEP_MS; frame += 1) {
      run.machine.advance(MAX_FADE_STEP_MS);
    }

    expect(run.counts.settles).toBe(2);
  });
});
