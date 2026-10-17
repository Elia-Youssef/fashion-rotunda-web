import { describe, expect, it, vi } from 'vitest';

import {
  ATTRACT_IDLE_MS,
  ATTRACT_MOVE_MS,
  ATTRACT_RADIUS_M,
  ATTRACT_HEIGHT_M,
  ATTRACT_TARGET_HEIGHT_M,
  ATTRACT_FOV_DEG,
  ATTRACT_PERIOD_MS,
  createAttract,
} from '../../src/camera/attract';
import { copyPose } from '../../src/camera/blend';
import type { AttractReading } from '../../src/camera/attract';

const START_POSE: AttractReading['pose'] = { position: [0, 1.7, 4.2], target: [0, 1, 0] };

function readStart(destination: AttractReading): void {
  copyPose(START_POSE, destination.pose);
  destination.fov = 40;
}

describe('attract loop state machine', () => {
  it('reports the remaining idle wait only while a tour can start', () => {
    let clock = 7_000;
    const options = {
      readStart, idleMs: 6_000, moveMs: 3_000,
      enabled: true, reducedMotion: false, now: () => clock,
    };
    const attract = createAttract(options);
    expect(attract.msUntilStart()).toBe(6_000);
    clock += 4_000;
    expect(attract.msUntilStart()).toBe(2_000);
    attract.noteInput();
    expect(attract.msUntilStart()).toBe(6_000);
    clock += 7_000;
    expect(attract.msUntilStart()).toBe(0);
    expect(attract.running).toBe(false);
    attract.tick();
    expect(attract.msUntilStart()).toBeNull();
    attract.noteInput();
    attract.setEnabled(false);
    expect(attract.msUntilStart()).toBeNull();
    attract.setEnabled(true);
    expect(attract.msUntilStart()).toBe(6_000);
    attract.setReducedMotion(true);
    expect(attract.msUntilStart()).toBeNull();
    clock += 7_000;
    attract.setReducedMotion(false);
    expect(attract.msUntilStart()).toBe(6_000);
  });

  it('exports expected timing constants', () => {
    expect(ATTRACT_IDLE_MS).toBe(60_000);
    expect(ATTRACT_MOVE_MS).toBe(3_000);
  });

  it('stays idle before idleMs, then starts touring at idleMs', () => {
    let clock = 0;
    const attract = createAttract({
      readStart,
      idleMs: 10_000,
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
    expect(reading?.viewId).toBe('orbit');
  });

  it('anchors the idle wait at creation, not at the epoch', () => {
    let clock = 7_000;
    const attract = createAttract({
      readStart,
      idleMs: 5_000,
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
        readStart,
        idleMs: ATTRACT_IDLE_MS,
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
      readStart,
      idleMs: 5_000,
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

  it('never starts under reduced motion, including after explicit enable', () => {
    let clock = 0;
    const attract = createAttract({
      readStart,
      idleMs: 1_000,
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
      readStart, idleMs: 1_000, moveMs: 3_000,
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
      readStart, idleMs: 1_000, moveMs: 3_000,
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
      readStart,
      idleMs: 1_000,
      moveMs: 1_000,
      enabled: false,
      reducedMotion: false,
      now: () => clock,
    });

    clock = 50_000;
    expect(attract.tick()).toBeNull();
    expect(attract.running).toBe(false);

    attract.setEnabled(true);
    // The existing idle deadline has already passed when enabled.
    clock = 51_000;
    expect(attract.tick()).not.toBeNull();
    expect(attract.running).toBe(true);
  });

  it('disabling mid-tour stops it and restarts the idle wait from that moment', () => {
    let clock = 0;
    const attract = createAttract({
      readStart,
      idleMs: 5_000,
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
      readStart,
      idleMs: 5_000,
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
      readStart,
      idleMs: 1_000,
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
    expect(third?.viewId).toBe('orbit');
    expect(third?.pose.position[0]).toBeGreaterThan(0);
  });
});

function orbitTour() {
  let clock = 0;
  const live: AttractReading = {
    pose: { position: [3, 3, -4], target: [0.4, 0.7, -0.2] }, viewId: '', fov: 36,
  };
  const read = vi.fn((destination: AttractReading) => {
    copyPose(live.pose, destination.pose);
    destination.fov = live.fov;
  });
  const tour = createAttract({
    readStart: read, idleMs: 1_000, moveMs: ATTRACT_MOVE_MS,
    enabled: true, reducedMotion: false, now: () => clock,
  });
  function tick(elapsed: number): AttractReading {
    clock = 1_000 + elapsed;
    const reading = tour.tick();
    expect(reading).not.toBeNull();
    return reading!;
  }
  return { tour, live, read, tick };
}

function theta(reading: AttractReading): number {
  return Math.atan2(reading.pose.position[0], reading.pose.position[2]);
}

function angleDifference(after: number, before: number): number {
  return Math.atan2(Math.sin(after - before), Math.cos(after - before));
}

describe('continuous idle orbit', () => {
  it('exports the approved orbit geometry and timing', () => {
    expect(ATTRACT_RADIUS_M).toBe(5);
    expect(ATTRACT_HEIGHT_M).toBe(2);
    expect(ATTRACT_TARGET_HEIGHT_M).toBe(1.1);
    expect(ATTRACT_FOV_DEG).toBe(50);
    expect(ATTRACT_PERIOD_MS).toBe(60_000);
  });

  it('stays on the five metre circle at two metres high through repeated turns', () => {
    const { tick } = orbitTour();
    tick(0);
    for (let elapsed = 3_000; elapsed <= 183_000; elapsed += 713) {
      const { pose } = tick(elapsed);
      expect(Math.abs(Math.hypot(pose.position[0], pose.position[2]) - 5)).toBeLessThan(0.001);
      expect(Math.abs(pose.position[1] - 2)).toBeLessThan(0.001);
    }
  });

  it('increases azimuth at one full turn per minute regardless of tick spacing', () => {
    const { tick } = orbitTour();
    tick(0);
    let previous = theta(tick(3_000));
    let total = 0;
    let previousElapsed = 3_000;
    for (const elapsed of [3_017, 4_100, 11_003, 23_000, 41_000, 59_123, 63_000]) {
      const current = theta(tick(elapsed));
      const advanced = angleDifference(current, previous);
      expect(advanced).toBeCloseTo(2 * Math.PI * (elapsed - previousElapsed) / 60_000, 10);
      total += advanced;
      previous = current;
      previousElapsed = elapsed;
    }
    expect(total).toBeCloseTo(2 * Math.PI, 10);
  });

  it('samples the current pose at each start without a first tick jump', () => {
    const { tick, tour, live, read } = orbitTour();
    expect(tour.tick()).toBeNull();
    expect(read).not.toHaveBeenCalled();
    live.pose.position = [-4, 2.4, -3];
    expect(tick(0).pose).toEqual(live.pose);
    expect(tick(0).fov).toBe(36);
    expect(read).toHaveBeenCalledOnce();
    const initialTheta = Math.atan2(-4, -3);
    expect(Math.abs(angleDifference(theta(tick(1)), initialTheta))).toBeLessThan(1e-9);
    tour.noteInput();
    live.pose.position = [2, 1.8, 3];
    live.pose.target = [-0.3, 1.2, 0.6];
    live.fov = 47;
    expect(tick(1_001).pose).toEqual(live.pose);
    expect(tick(1_001).fov).toBe(47);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('ramps angular speed from zero to cruising speed continuously during the glide', () => {
    const { tick } = orbitTour();
    const startTheta = theta(tick(0));
    const speed = 2 * Math.PI / 60_000;
    const firstStep = angleDifference(theta(tick(1)), startTheta);
    expect(firstStep).toBeGreaterThan(0);
    expect(firstStep).toBeLessThan(speed * 1e-5);
    let previousSpeed = firstStep;
    for (const elapsed of [300, 750, 1_500, 2_250, 3_000]) {
      const before = theta(tick(elapsed - 1));
      const after = theta(tick(elapsed));
      const currentSpeed = angleDifference(after, before);
      expect(currentSpeed).toBeGreaterThan(previousSpeed);
      expect(currentSpeed).toBeLessThanOrEqual(speed);
      previousSpeed = currentSpeed;
    }
    const before = theta(tick(2_999));
    const end = theta(tick(3_000));
    const after = theta(tick(3_001));
    expect(angleDifference(end, before) / speed).toBeCloseTo(1, 5);
    expect(angleDifference(after, end) / speed).toBeCloseTo(1, 10);
  });

  it('eases radius height aim and fov to the specified arrival over three seconds', () => {
    const { tick, live } = orbitTour();
    live.pose.position = [0, 4, 7];
    tick(0);
    for (const elapsed of [750, 1_500, 2_250, 3_000]) {
      const t = elapsed / 3_000;
      const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      const reading = tick(elapsed);
      expect(Math.hypot(reading.pose.position[0], reading.pose.position[2]))
        .toBeCloseTo(7 + (5 - 7) * eased, 10);
      expect(reading.pose.position[1]).toBeCloseTo(4 + (2 - 4) * eased, 10);
      expect(reading.pose.target[0]).toBeCloseTo(0.4 * (1 - eased), 10);
      expect(reading.pose.target[1]).toBeCloseTo(0.7 + (1.1 - 0.7) * eased, 10);
      expect(reading.pose.target[2]).toBeCloseTo(-0.2 * (1 - eased), 10);
      expect(reading.fov).toBeCloseTo(36 + (50 - 36) * eased, 10);
    }
    expect(tick(4_000).pose.target).toEqual([0, 1.1, -0]);
    expect(tick(4_000).fov).toBe(50);
  });

  it('stops on input during both glide and continuous orbit without changing the stopped reading', () => {
    for (const elapsed of [1_500, 5_000]) {
      const { tick, tour } = orbitTour();
      tick(0);
      const reading = tick(elapsed);
      const stopped = structuredClone(reading);
      tour.noteInput();
      expect(tour.running).toBe(false);
      expect(tour.tick()).toBeNull();
      expect(reading).toEqual(stopped);
      expect(tour.msUntilStart()).toBe(1_000);
    }
  });

  it('reuses the reading and pose storage while reading the live camera only at launch', () => {
    const { tick, read } = orbitTour();
    const first = tick(0);
    const pose = first.pose;
    const position = pose.position;
    const target = pose.target;
    for (const elapsed of [500, 3_000, 9_000, 70_000]) {
      const reading = tick(elapsed);
      expect(reading).toBe(first);
      expect(reading.pose).toBe(pose);
      expect(reading.pose.position).toBe(position);
      expect(reading.pose.target).toBe(target);
    }
    expect(read).toHaveBeenCalledOnce();
  });
});
