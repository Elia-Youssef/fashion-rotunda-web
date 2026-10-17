// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountJoystick } from '../../src/camera/joystick';

// The pin below and its negative control share this probe, so the control proves the probe
// discriminates between a hidden and an exposed joystick instead of passing vacuously.
function hiddenFromAssistiveTech(element: HTMLElement): boolean {
  return element.getAttribute('aria-hidden') === 'true';
}

describe('mountJoystick', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  // A visible joystick whose base rect spans (100, 100) to (200, 200), so drags are measured
  // from the center at (150, 150). The full deflection radius is 36 px.
  const CENTER_X = 150;
  const CENTER_Y = 150;

  function mountVisible(onVector: (x: number, y: number) => void) {
    const handle = mountJoystick(root, onVector);
    handle.setVisible(true);
    const base = root.querySelector('.archviz-joystick-base') as HTMLElement;
    vi.spyOn(base, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 100,
      width: 100,
      height: 100,
      right: 200,
      bottom: 200,
      x: 100,
      y: 100,
      toJSON: () => {},
    });
    const knob = base.querySelector('.archviz-joystick-knob') as HTMLElement;
    const container = root.querySelector('.archviz-joystick') as HTMLElement;
    return { handle, base, knob, container };
  }

  function pointer(base: HTMLElement, type: string, id: number, x: number, y: number): void {
    base.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y }));
  }

  // The untouched axis of a drag publishes a negative zero through the atan2 path, so vector
  // components compare by numeric value, not by the sign of zero.
  function expectLastVector(onVector: ReturnType<typeof vi.fn>, x: number, y: number): void {
    expect(onVector).toHaveBeenCalled();
    const last = onVector.mock.calls[onVector.mock.calls.length - 1] as [number, number];
    expect(last[0]).toBeCloseTo(x, 5);
    expect(last[1]).toBeCloseTo(y, 5);
  }

  it('mounts hidden and responds to setVisible', () => {
    const onVector = vi.fn();
    const handle = mountJoystick(root, onVector);
    expect(handle.visible).toBe(false);

    const container = root.querySelector('.archviz-joystick') as HTMLElement;
    expect(container).not.toBeNull();
    expect(container.hidden).toBe(true);

    handle.setVisible(true);
    expect(handle.visible).toBe(true);
    expect(container.hidden).toBe(false);

    handle.dispose();
  });

  it('stays hidden from assistive technology, including while visible', () => {
    const onVector = vi.fn();
    const handle = mountJoystick(root, onVector);

    const container = root.querySelector('.archviz-joystick') as HTMLElement;
    expect(hiddenFromAssistiveTech(container)).toBe(true);

    handle.setVisible(true);
    expect(container.hidden).toBe(false);
    expect(hiddenFromAssistiveTech(container)).toBe(true);

    handle.dispose();
  });

  it('reports a joystick left exposed to assistive technology', () => {
    // Negative control: the pre-fix joystick carried no aria attributes at all, so the probe
    // must report it as exposed once the attribute is missing.
    const handle = mountJoystick(root, vi.fn());

    const container = root.querySelector('.archviz-joystick') as HTMLElement;
    container.removeAttribute('aria-hidden');
    expect(hiddenFromAssistiveTech(container)).toBe(false);

    handle.dispose();
  });

  it('delivers normalized vectors on pointer drag and resets on release', () => {
    const onVector = vi.fn();
    const handle = mountJoystick(root, onVector);
    handle.setVisible(true);

    const base = root.querySelector('.archviz-joystick-base') as HTMLElement;
    vi.spyOn(base, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 100,
      width: 100,
      height: 100,
      right: 200,
      bottom: 200,
      x: 100,
      y: 100,
      toJSON: () => {},
    });

    // Center is at (150, 150). Drag upwards to (150, 100) -> dy = -50 (forward).
    base.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 150, clientY: 150 }));
    base.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 150, clientY: 100 }));

    expect(onVector).toHaveBeenCalled();
    const lastCall = onVector.mock.calls[onVector.mock.calls.length - 1];
    expect(lastCall[0]).toBeCloseTo(0, 1); // strafe 0
    expect(lastCall[1]).toBeCloseTo(1, 1); // forward +1

    base.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 150, clientY: 100 }));
    expect(onVector).toHaveBeenLastCalledWith(0, 0);

    handle.dispose();
  });

  it('publishes the vector of the press position before any move', () => {
    const onVector = vi.fn();
    const { handle, base } = mountVisible(onVector);
    pointer(base, 'pointerdown', 1, CENTER_X + 18, CENTER_Y);
    expectLastVector(onVector, 0.5, 0);
    handle.dispose();
  });

  it('scales the vector linearly up to the drag radius', () => {
    const onVector = vi.fn();
    const { handle, base } = mountVisible(onVector);
    pointer(base, 'pointerdown', 1, CENTER_X, CENTER_Y);
    pointer(base, 'pointermove', 1, CENTER_X + 9, CENTER_Y);
    expectLastVector(onVector, 0.25, 0);
    pointer(base, 'pointermove', 1, CENTER_X + 18, CENTER_Y);
    expectLastVector(onVector, 0.5, 0);
    pointer(base, 'pointermove', 1, CENTER_X + 72, CENTER_Y);
    expectLastVector(onVector, 1, 0);
    handle.dispose();
  });

  it('ignores a second pointer while a drag is active', () => {
    const onVector = vi.fn();
    const { handle, base } = mountVisible(onVector);
    pointer(base, 'pointerdown', 1, CENTER_X, CENTER_Y);
    pointer(base, 'pointermove', 1, CENTER_X + 36, CENTER_Y);
    pointer(base, 'pointerdown', 2, CENTER_X, CENTER_Y - 36);
    pointer(base, 'pointermove', 2, CENTER_X - 36, CENTER_Y);
    expectLastVector(onVector, 1, 0);
    pointer(base, 'pointerup', 1, CENTER_X + 36, CENTER_Y);
    expect(onVector).toHaveBeenLastCalledWith(0, 0);
    handle.dispose();
  });

  it('ignores a pointerup from a pointer that never pressed', () => {
    const onVector = vi.fn();
    const { handle, base } = mountVisible(onVector);
    pointer(base, 'pointerdown', 1, CENTER_X, CENTER_Y);
    pointer(base, 'pointermove', 1, CENTER_X + 18, CENTER_Y);
    pointer(base, 'pointerup', 2, CENTER_X, CENTER_Y);
    expectLastVector(onVector, 0.5, 0);
    pointer(base, 'pointerup', 1, CENTER_X + 18, CENTER_Y);
    expect(onVector).toHaveBeenLastCalledWith(0, 0);
    handle.dispose();
  });

  it('recentres the knob on release', () => {
    const { handle, base, knob } = mountVisible(vi.fn());
    pointer(base, 'pointerdown', 1, CENTER_X, CENTER_Y);
    pointer(base, 'pointermove', 1, CENTER_X + 18, CENTER_Y);
    expect(knob.style.transform).toBe('translate(18.0px, 0.0px)');
    pointer(base, 'pointerup', 1, CENTER_X + 18, CENTER_Y);
    expect(knob.style.transform).toBe('translate(0px, 0px)');
    handle.dispose();
  });

  it('zeroes and recentres an active drag when hidden', () => {
    const onVector = vi.fn();
    const { handle, base, knob, container } = mountVisible(onVector);
    pointer(base, 'pointerdown', 1, CENTER_X, CENTER_Y);
    pointer(base, 'pointermove', 1, CENTER_X + 18, CENTER_Y);
    handle.setVisible(false);
    expect(handle.visible).toBe(false);
    expect(container.hidden).toBe(true);
    expect(onVector).toHaveBeenLastCalledWith(0, 0);
    expect(knob.style.transform).toBe('translate(0px, 0px)');
    pointer(base, 'pointermove', 1, CENTER_X + 36, CENTER_Y);
    expect(onVector, 'a hidden joystick keeps no active drag').toHaveBeenLastCalledWith(0, 0);
    handle.dispose();
  });

  it('stops responding and leaves the DOM on dispose', () => {
    const onVector = vi.fn();
    const { handle, base } = mountVisible(onVector);
    pointer(base, 'pointerdown', 1, CENTER_X, CENTER_Y);
    const callsAtDispose = onVector.mock.calls.length;
    handle.dispose();
    expect(root.querySelector('.archviz-joystick')).toBeNull();
    pointer(base, 'pointermove', 1, CENTER_X + 36, CENTER_Y);
    pointer(base, 'pointerup', 1, CENTER_X + 36, CENTER_Y);
    expect(onVector).toHaveBeenCalledTimes(callsAtDispose);
  });
});
