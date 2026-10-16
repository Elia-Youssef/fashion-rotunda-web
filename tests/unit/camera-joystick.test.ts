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
});
