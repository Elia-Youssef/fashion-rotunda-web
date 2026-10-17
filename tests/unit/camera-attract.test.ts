// Unit tests for the attract loop state machine with a fake clock.
// Verifies idle start, input interruption, tour order, hold/move timing, reduced motion, the
// reused tick reading, the setEnabled contract, degenerate view lists, the default clock, and
// exact replay against poses recorded from the allocating tour.

import { describe, expect, it, vi } from 'vitest';

import {
  ATTRACT_HOLD_MS,
  ATTRACT_IDLE_MS,
  ATTRACT_MOVE_MS,
  createAttract,
} from '../../src/camera/attract';
import type { NamedView } from '../../src/camera/presets';
import golden from '../fixtures/camera-pose-golden.json';

const VIEWS: NamedView[] = [
  { id: 'proof', label: 'Proof', position: [0, 1.7, 4.2], target: [0, 1, 0], fov: 40 },
  { id: 'entrance', label: 'Entrance', position: [0, 2.2, 6.2], target: [0, 1, 0], fov: 52 },
  { id: 'detail', label: 'Detail', position: [0, 1.4, 1.396], target: [0, 1.3, 0], fov: 35 },
];

describe('attract loop state machine', () => {
  it('exports expected timing constants', () => {
    expect(ATTRACT_IDLE_MS).toBe(60_000);
    expect(ATTRACT_HOLD_MS).toBe(4_000);
    expect(ATTRACT_MOVE_MS).toBe(3_000);
  });

  it('stays idle before idleMs, then starts touring at idleMs', () => {
    let clock = 0;
    const attract = createAttract({
      views: VIEWS,
      idleMs: 10_000,
      holdMs: 4_000,
      moveMs: 3_000,
      enabled: true,
      reducedMotion: false,
      now: () => clock,
    });

    expect(attract.running).toBe(false);
    expect(attract.tick()).toBeNull();

    // Advance to 9,999 ms: still quiet.
    clock = 9_999;
    expect(attract.tick()).toBeNull();
    expect(attract.running).toBe(false);

    // Advance to 10,000 ms: triggers tour!
    clock = 10_000;
    const reading = attract.tick();
    expect(attract.running).toBe(true);
    expect(reading).not.toBeNull();
    expect(reading?.viewId).toBe('entrance');
  });

  it('anchors the idle wait at creation, not at the epoch', () => {
    let clock = 7_000;
    const attract = createAttract({
      views: VIEWS,
      idleMs: 5_000,
      holdMs: 2_000,
      moveMs: 1_000,
      enabled: true,
      reducedMotion: false,
      now: () => clock,
    });

    clock = 11_999;
    expect(attract.tick()).toBeNull();
    clock = 12_000;
    expect(attract.tick()).not.toBeNull();
    expect(attract.running).toBe(true);
  });

  it('uses the real clock when no now is provided', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const attract = createAttract({
        views: VIEWS,
        idleMs: ATTRACT_IDLE_MS,
        holdMs: ATTRACT_HOLD_MS,
        moveMs: ATTRACT_MOVE_MS,
        enabled: true,
        reducedMotion: false,
      });

      expect(attract.tick()).toBeNull();
      vi.advanceTimersByTime(ATTRACT_IDLE_MS);
      expect(attract.tick()).not.toBeNull();
      expect(attract.running).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops immediately on input and restarts the idle wait', () => {
    let clock = 0;
    const attract = createAttract({
      views: VIEWS,
      idleMs: 5_000,
      holdMs: 2_000,
      moveMs: 1_000,
      enabled: true,
      reducedMotion: false,
      now: () => clock,
    });

    clock = 5_000;
    expect(attract.tick()).not.toBeNull();
    expect(attract.running).toBe(true);

    // User touches canvas or moves pointer.
    clock = 5_500;
    attract.noteInput();
    expect(attract.running).toBe(false);
    expect(attract.tick()).toBeNull();

    // Must wait another 5,000 ms from 5,500.
    clock = 10_499;
    expect(attract.tick()).toBeNull();

    clock = 10_500;
    expect(attract.tick()).not.toBeNull();
    expect(attract.running).toBe(true);
  });

  it('tours presets in order with exact move and hold phases', () => {
    let clock = 0;
    const attract = createAttract({
      views: VIEWS,
      idleMs: 1_000,
      holdMs: 2_000,
      moveMs: 1_000,
      enabled: true,
      reducedMotion: false,
      now: () => clock,
    });

    // Start tour at 1,000 ms.
    clock = 1_000;
    const start = attract.tick();
    expect(start?.viewId).toBe('entrance');

    // Midway through move phase (1,500 ms).
    clock = 1_500;
    const moving = attract.tick();
    expect(moving?.viewId).toBe('entrance');
    // Position interpolated between proof [0, 1.7, 4.2] and entrance [0, 2.2, 6.2].
    expect(moving?.pose.position[2]).toBeGreaterThan(4.2);
    expect(moving?.pose.position[2]).toBeLessThan(6.2);

    // Move completes at 2,000 ms -> lands on entrance.
    clock = 2_000;
    const landed = attract.tick();
    expect(landed?.viewId).toBe('entrance');
    expect(landed?.pose.position[2]).toBeCloseTo(6.2, 5);

    // Hold phase (2,000 ms to 4,000 ms).
    clock = 3_500;
    expect(attract.tick()?.viewId).toBe('entrance');

    // Next preset (detail) begins at 4,000 ms without a destination flash. The first frame stays
    // on entrance, and the following frame begins the glide toward detail.
    clock = 4_000;
    const nextStart = attract.tick();
    expect(nextStart?.viewId).toBe('detail');
    expect(nextStart?.pose.position).toEqual(VIEWS[1].position);
    expect(nextStart?.fov).toBe(52);

    clock = 4_500;
    const nextMoving = attract.tick();
    expect(nextMoving?.pose.position[2]).toBeGreaterThan(VIEWS[2].position[2]);
    expect(nextMoving?.pose.position[2]).toBeLessThan(VIEWS[1].position[2]);
    expect(nextMoving?.fov).toBeGreaterThan(35);
    expect(nextMoving?.fov).toBeLessThan(52);
  });

  it('tours the only view when the list has one entry', () => {
    let clock = 0;
    const attract = createAttract({
      views: [VIEWS[0]],
      idleMs: 1_000,
      holdMs: 2_000,
      moveMs: 1_000,
      enabled: true,
      reducedMotion: false,
      now: () => clock,
    });

    clock = 1_000;
    const launch = attract.tick();
    expect(launch?.viewId).toBe('proof');
    expect(attract.running).toBe(true);

    // The glide to itself lands and holds; the wraparound stays on the only view.
    clock = 2_000;
    expect(attract.tick()?.pose.position[2]).toBeCloseTo(VIEWS[0].position[2], 5);
    clock = 4_000;
    const wrapped = attract.tick();
    expect(wrapped?.viewId).toBe('proof');
    expect(wrapped?.pose.position).toEqual(VIEWS[0].position);
  });

  it('never tours when the view list is empty', () => {
    let clock = 0;
    const attract = createAttract({
      views: [],
      idleMs: 1_000,
      holdMs: 2_000,
      moveMs: 1_000,
      enabled: true,
      reducedMotion: false,
      now: () => clock,
    });

    clock = 50_000;
    expect(attract.tick()).toBeNull();
    expect(attract.running).toBe(false);
  });

  it('never starts under reduced motion, including after explicit enable', () => {
    let clock = 0;
    const attract = createAttract({
      views: VIEWS,
      idleMs: 1_000,
      holdMs: 2_000,
      moveMs: 3_000,
      enabled: true,
      reducedMotion: true,
      now: () => clock,
    });

    clock = 1_000;
    expect(attract.tick()).toBeNull();
    expect(attract.running).toBe(false);
    attract.setEnabled(false);
    attract.setEnabled(true);
    clock = 50_000;
    expect(attract.tick()).toBeNull();
    expect(attract.running).toBe(false);
  });

  it('stops on reduced motion and waits for fresh idle time when motion is allowed again', () => {
    let clock = 0;
    const attract = createAttract({
      views: VIEWS, idleMs: 1_000, holdMs: 2_000, moveMs: 3_000,
      enabled: true, reducedMotion: false, now: () => clock,
    });
    clock = 1_000;
    expect(attract.tick()).not.toBeNull();
    expect(attract.running).toBe(true);
    attract.setReducedMotion(true);
    expect(attract.running).toBe(false);
    clock = 10_000;
    expect(attract.tick()).toBeNull();
    attract.setReducedMotion(false);
    clock = 10_999;
    expect(attract.tick()).toBeNull();
    clock = 11_000;
    expect(attract.tick()).not.toBeNull();
    expect(attract.running).toBe(true);
  });

  it('keeps explicit disable and the idle clock independent of repeated preference values', () => {
    let clock = 0;
    const attract = createAttract({
      views: VIEWS, idleMs: 1_000, holdMs: 2_000, moveMs: 3_000,
      enabled: false, reducedMotion: true, now: () => clock,
    });
    attract.setReducedMotion(false);
    clock = 10_000;
    expect(attract.tick()).toBeNull();
    expect(attract.enabled).toBe(false);
    attract.setEnabled(true);
    expect(attract.tick()).not.toBeNull();
    attract.setReducedMotion(false);
    expect(attract.running).toBe(true);
  });

  it('does nothing when disabled', () => {
    let clock = 0;
    const attract = createAttract({
      views: VIEWS,
      idleMs: 1_000,
      holdMs: 2_000,
      moveMs: 1_000,
      enabled: false,
      reducedMotion: false,
      now: () => clock,
    });

    clock = 50_000;
    expect(attract.tick()).toBeNull();
    expect(attract.running).toBe(false);

    attract.setEnabled(true);
    // Restart clock from enable.
    clock = 51_000;
    expect(attract.tick()).not.toBeNull();
    expect(attract.running).toBe(true);
  });

  it('disabling mid-tour stops it and restarts the idle wait from that moment', () => {
    let clock = 0;
    const attract = createAttract({
      views: VIEWS,
      idleMs: 5_000,
      holdMs: 2_000,
      moveMs: 1_000,
      enabled: true,
      reducedMotion: false,
      now: () => clock,
    });
    expect(attract.enabled).toBe(true);

    clock = 5_000;
    expect(attract.tick()).not.toBeNull();
    expect(attract.running).toBe(true);

    clock = 6_000;
    attract.setEnabled(false);
    expect(attract.enabled).toBe(false);
    expect(attract.running).toBe(false);
    expect(attract.tick()).toBeNull();

    // Re-enabling does not resume the tour: the idle wait runs from the disable at 6,000.
    clock = 6_500;
    attract.setEnabled(true);
    expect(attract.enabled).toBe(true);
    expect(attract.tick()).toBeNull();

    clock = 10_999;
    expect(attract.tick()).toBeNull();
    clock = 11_000;
    expect(attract.tick()).not.toBeNull();
    expect(attract.running).toBe(true);
  });

  it('a repeated disable leaves the idle wait where the first disable set it', () => {
    let clock = 0;
    const attract = createAttract({
      views: VIEWS,
      idleMs: 5_000,
      holdMs: 2_000,
      moveMs: 1_000,
      enabled: true,
      reducedMotion: false,
      now: () => clock,
    });

    clock = 5_000;
    expect(attract.tick()).not.toBeNull();

    clock = 6_000;
    attract.setEnabled(false);
    clock = 9_000;
    attract.setEnabled(false); // Same value: must not restart the idle clock.

    clock = 9_500;
    attract.setEnabled(true);
    clock = 10_999;
    expect(attract.tick()).toBeNull(); // 10,999 - 6,000 = 4,999
    clock = 11_000;
    expect(attract.tick()).not.toBeNull(); // 11,000 - 6,000 = 5,000
  });

  it('hands out the same reading, pose and arrays on every tick', () => {
    // The tour owns its reading and rewrites it per tick: nothing on a tour frame may allocate.
    let clock = 0;
    const attract = createAttract({
      views: VIEWS,
      idleMs: 1_000,
      holdMs: 2_000,
      moveMs: 1_000,
      enabled: true,
      reducedMotion: false,
      now: () => clock,
    });

    clock = 1_000;
    const first = attract.tick();
    expect(first).not.toBeNull();
    clock = 1_500;
    const second = attract.tick();
    clock = 2_500;
    const third = attract.tick();
    clock = 4_000;
    const fourth = attract.tick();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(fourth).toBe(first);
    expect(second?.pose).toBe(first?.pose);
    expect(second?.pose.position).toBe(first?.pose.position);
    expect(second?.pose.target).toBe(first?.pose.target);
    // The reuse carries fresh values, not stale ones.
    expect(third?.viewId).toBe('entrance');
    expect(third?.pose.position[2]).toBeCloseTo(6.2, 5);
  });

  it.each([
    ['normal tour', 'normal' as const],
    ['instant tour', 'reduced' as const],
  ])('replays the recorded %s pose for pose', (_name, key) => {
    const recorded = golden.attract[key];
    // The fixture must describe this test's views, or the replay would compare against a
    // tour of some other scene.
    expect(recorded.views).toEqual(VIEWS);

    let clock = 0;
    const attract = createAttract({
      views: VIEWS,
      idleMs: 1_000,
      holdMs: 2_000,
      moveMs: key === 'reduced' ? 0 : 3_000,
      enabled: true,
      reducedMotion: false,
      now: () => clock,
    });

    recorded.schedule.forEach((moment, index) => {
      clock = moment;
      const reading = attract.tick();
      const expected = recorded.ticks[index]?.reading;
      expect(expected).toBeDefined();
      if (expected === null) {
        expect(reading).toBeNull();
        return;
      }
      expect(reading).not.toBeNull();
      expect(reading?.viewId).toBe(expected.viewId);
      expect(reading?.fov).toBe(expected.fov);
      expect(reading?.pose.position).toEqual(expected.pose.position);
      expect(reading?.pose.target).toEqual(expected.pose.target);
    });
  });
});
