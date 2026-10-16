import { describe, expect, it, vi } from 'vitest';

import { createTurntable } from '../../src/camera/turntable';

const DEG = Math.PI / 180;

function make(degreesPerSecond = 20) {
  const onChange = vi.fn();
  const turntable = createTurntable({ degreesPerSecond, onChange });
  return { turntable, onChange };
}

describe('createTurntable', () => {
  it('advances at the configured rate', () => {
    const { turntable } = make(20);
    turntable.start();
    expect(turntable.update(1000)).toBeCloseTo(20 * DEG, 12);
    expect(turntable.update(500)).toBeCloseTo(30 * DEG, 12);
  });

  it('start, stop and toggle flip running', () => {
    const { turntable } = make();
    expect(turntable.running).toBe(false);
    turntable.start();
    expect(turntable.running).toBe(true);
    turntable.stop();
    expect(turntable.running).toBe(false);
    turntable.toggle();
    expect(turntable.running).toBe(true);
    turntable.toggle();
    expect(turntable.running).toBe(false);
  });

  it('notifies on start and stop, and stays quiet when the state does not change', () => {
    const { turntable, onChange } = make();
    turntable.start();
    turntable.start();
    turntable.stop();
    turntable.stop();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('grows the yaw without wrapping: the showroom takes any radians', () => {
    const { turntable } = make(20);
    turntable.start();
    // Twenty seconds is past a full turn at 20 deg/s; wrapping would read it as the overshoot.
    const yaw = turntable.update(20000);
    expect(yaw).toBeCloseTo(400 * DEG, 12);
    expect(yaw).toBeGreaterThan(2 * Math.PI);
  });

  it('update notifies on each advancing step', () => {
    const { turntable, onChange } = make(20);
    turntable.start();
    onChange.mockClear();
    turntable.update(100);
    expect(onChange).toHaveBeenCalledTimes(1);
    turntable.update(50);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('holds the yaw while stopped: update returns it and notifies nothing', () => {
    const { turntable, onChange } = make(20);
    turntable.start();
    const held = turntable.update(2000);
    turntable.stop();
    onChange.mockClear();
    expect(turntable.update(5000)).toBe(held);
    expect(turntable.yaw).toBe(held);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a zero dt does not advance the yaw', () => {
    const { turntable } = make(20);
    turntable.start();
    expect(turntable.update(0)).toBe(0);
    expect(turntable.update(1000)).toBeCloseTo(20 * DEG, 12);
  });

  it('a non-positive dt notifies nothing while running', () => {
    const { turntable, onChange } = make(20);
    turntable.start();
    onChange.mockClear();
    expect(turntable.update(0)).toBe(0);
    expect(turntable.update(-100)).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('setYaw moves the yaw directly and notifies', () => {
    const { turntable, onChange } = make();
    turntable.setYaw(0.5);
    expect(turntable.yaw).toBe(0.5);
    expect(onChange).toHaveBeenCalledTimes(1);
    turntable.start();
    turntable.update(1000);
    turntable.setYaw(0);
    expect(turntable.yaw).toBe(0);
  });

  it('setYaw to the value it already holds notifies nothing', () => {
    const { turntable, onChange } = make();
    turntable.setYaw(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('the yaw getter reads the unbounded accumulator, not a wrapped angle', () => {
    const { turntable } = make(20);
    turntable.start();
    const yaw = turntable.update(20000);
    // Callers compare the getter by identity against the yaw update returned, so wrapping the
    // read would make every later comparison read as a change.
    expect(turntable.yaw).toBe(yaw);
    expect(turntable.yaw).toBeGreaterThan(2 * Math.PI);
    turntable.stop();
    turntable.setYaw(yaw + 0.5);
    expect(turntable.yaw).toBe(yaw + 0.5);
  });
});
