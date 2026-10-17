// @vitest-environment jsdom
import { Vector3 } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';

import { canvas, make, PROOF_VIEW } from '../support/camera-mount';
import type { OrbitHandle } from '../../src/camera/orbit';

const CANVAS_HEIGHT = 600;
const PROOF_DISTANCE = Math.hypot(0.7, 4.2);

function sizedCanvas(): void {
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, CANVAS_HEIGHT));
}

function pointer(type: string, y: number, init: PointerEventInit = {}): void {
  canvas.dispatchEvent(new PointerEvent(type, {
    pointerId: 1, pointerType: 'mouse', button: 2, buttons: 2,
    clientX: 100, clientY: y, bubbles: true, cancelable: true, ...init,
  }));
}

function key(value: string, repeat = false, element: HTMLElement = canvas): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, repeat, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

function offset(orbit: OrbitHandle): Vector3 {
  return new Vector3(...orbit.position).sub(new Vector3(...orbit.target));
}

function expectOffset(orbit: OrbitHandle, before: Vector3, scale = 1): void {
  const after = offset(orbit);
  expect(after.x).toBeCloseTo(before.x * scale, 10);
  expect(after.y).toBeCloseTo(before.y * scale, 10);
  expect(after.z).toBeCloseTo(before.z * scale, 10);
}

describe('vertical orbit pan', () => {
  it.each([[40, -40, 1], [40, 40, 1], [60, -40, 1], [40, -40, 1.1]])(
    'right-drag follows the pixel scale at FOV %s, delta %s and distance factor %s', (fov, dy, factor) => {
      const { mount: current } = make();
      sizedCanvas();
      current.orbit.moveTo(PROOF_VIEW.position, PROOF_VIEW.target, fov);
      if (factor !== 1) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
      const before = offset(current.orbit);
      const positionY = current.orbit.position[1];
      const expected = dy * 2 * PROOF_DISTANCE * factor * Math.tan(fov * Math.PI / 360) / CANVAS_HEIGHT;
      pointer('pointerdown', 200);
      pointer('pointermove', 200 + dy, { clientX: 160 });
      expect(current.orbit.target).toEqual([0, expect.closeTo(1 + expected, 10), 0]);
      expect(current.orbit.position[1]).toBeCloseTo(positionY + expected, 10);
      expectOffset(current.orbit, before);
      pointer('pointerup', 200 + dy);
      expect(current.orbit.moving).toBe(false);
      current.update(100);
      expectOffset(current.orbit, before);
    },
  );

  it.each([-20, 20])('a projected world point follows a right-drag of %s pixels', (dy) => {
    const { camera } = make();
    sizedCanvas();
    const point = new Vector3(...PROOF_VIEW.target);
    const screenY = (): number => {
      camera.updateMatrixWorld();
      return (1 - point.clone().project(camera).y) * CANVAS_HEIGHT / 2;
    };
    const before = screenY();
    expect(before).toBeCloseTo(CANVAS_HEIGHT / 2, 10);
    pointer('pointerdown', before, { clientX: 400 });
    pointer('pointermove', before + dy, { clientX: 400 });
    const moved = screenY() - before;
    // World-y translation at the proof camera's slight pitch differs from screen-y by less
    // than half a pixel over a 20 px drag. Reversing the direction misses by about 40 px.
    const projectionTolerancePx = 0.5;
    expect(Math.abs(moved - dy)).toBeLessThan(projectionTolerancePx);
  });

  it('Shift with the left button pans vertically without rotating', () => {
    const { mount: current } = make();
    sizedCanvas();
    const before = offset(current.orbit);
    pointer('pointerdown', 200, { button: 0, buttons: 1, shiftKey: true });
    pointer('pointermove', 240, { button: -1, buttons: 1, clientX: 200, shiftKey: true });
    const expected = 40 * 2 * PROOF_DISTANCE * Math.tan(40 * Math.PI / 360) / CANVAS_HEIGHT;
    expect(current.orbit.target[1]).toBeCloseTo(1 + expected, 10);
    expectOffset(current.orbit, before);
  });

  it('Page keys translate by ten centimetres on each press and held-key repeat', () => {
    const { mount: current } = make();
    canvas.focus();
    const before = offset(current.orbit);
    expect(key('PageUp').defaultPrevented).toBe(true);
    expect(current.orbit.target[1]).toBeCloseTo(1.1, 10);
    expect(key('PageUp', true).defaultPrevented).toBe(true);
    expect(current.orbit.target[1]).toBeCloseTo(1.2, 10);
    expect(key('PageDown').defaultPrevented).toBe(true);
    expect(current.orbit.target[1]).toBeCloseTo(1.1, 10);
    expect(key('PageDown', true).defaultPrevented).toBe(true);
    expect(current.orbit.target[1]).toBeCloseTo(1, 10);
    expectOffset(current.orbit, before);
    expect(current.orbit.moving).toBe(false);
  });

  it('two fingers pan by their midpoint while spread changes still dolly', () => {
    const { mount: current } = make();
    sizedCanvas();
    const before = offset(current.orbit);
    const touch = { pointerType: 'touch', button: 0, buttons: 1 };
    pointer('pointerdown', 200, { ...touch, clientX: 100 });
    pointer('pointerdown', 200, { ...touch, pointerId: 2, clientX: 300 });
    expect(current.orbit.moving).toBe(true);
    // The first move shifts the midpoint 20 px and briefly widens the spread.
    pointer('pointermove', 240, { ...touch, clientX: 100 });
    const intermediateFactor = 200 / Math.hypot(200, 40);
    pointer('pointermove', 240, { ...touch, pointerId: 2, clientX: 300 });
    const expected = 20 * (1 + intermediateFactor) * 2 * PROOF_DISTANCE *
      Math.tan(40 * Math.PI / 360) / CANVAS_HEIGHT;
    expect(current.orbit.target[1]).toBeCloseTo(1 + expected, 10);
    expectOffset(current.orbit, before);
    // A horizontal spread change has no vertical midpoint change.
    pointer('pointermove', 240, { ...touch, pointerId: 2, clientX: 350 });
    expectOffset(current.orbit, before, 200 / 250);
    expect(current.orbit.target[1]).toBeCloseTo(1 + expected, 10);
    pointer('pointerup', 240, { ...touch, pointerId: 2, clientX: 350 });
    pointer('pointerup', 240, touch);
    expect(current.orbit.moving).toBe(false);
  });

  it('reanchors the midpoint when the first of three touch contacts leaves', () => {
    const { mount: current } = make();
    sizedCanvas();
    const touch = { pointerType: 'touch', button: 0, buttons: 1 };
    pointer('pointerdown', 200, touch);
    pointer('pointerdown', 200, { ...touch, pointerId: 2, clientX: 300 });
    pointer('pointermove', 240, touch);
    pointer('pointermove', 240, { ...touch, pointerId: 2, clientX: 300 });
    const height = current.orbit.target[1];
    expect(height).toBeGreaterThan(1);
    pointer('pointerdown', 400, { ...touch, pointerId: 3, clientX: 500 });
    pointer('pointerup', 240, touch);
    expect(current.orbit.target[1]).toBe(height);
    pointer('pointermove', 250, { ...touch, pointerId: 2, clientX: 300 });
    const expected = 5 * 2 * PROOF_DISTANCE * Math.tan(40 * Math.PI / 360) / CANVAS_HEIGHT;
    expect(current.orbit.target[1]).toBeCloseTo(height + expected, 10);
  });

  it.each(['PageUp', 'PageDown'])('clamps %s at the measured pan limit', (value) => {
    const { mount: current } = make();
    for (let step = 0; step < 40; step += 1) key(value, step > 0);
    expect(current.orbit.target[1]).toBe(value === 'PageUp' ? 2.1 : 0.15);
    const before = offset(current.orbit);
    key(value, true);
    expectOffset(current.orbit, before);
    key(value === 'PageUp' ? 'PageDown' : 'PageUp');
    expect(current.orbit.target[1]).toBeCloseTo(value === 'PageUp' ? 2 : 0.25, 10);
  });

  it.each([-10000, 10000])('clamps a pointer delta of %s at the measured pan limit', (dy) => {
    const { mount: current } = make();
    sizedCanvas();
    pointer('pointerdown', 200);
    pointer('pointermove', 200 + dy);
    expect(current.orbit.target[1]).toBe(dy > 0 ? 2.1 : 0.15);
  });

  it('wheel zoom after a pan dollies toward the new target height', () => {
    const { mount: current } = make();
    key('PageUp');
    expect(current.orbit.target[1]).toBeCloseTo(1.1, 10);
    const before = offset(current.orbit);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    expect(current.orbit.target[1]).toBeCloseTo(1.1, 10);
    expectOffset(current.orbit, before, 1 / 1.1);
  });

  it('Home restores the target height and position and finishes a pending glide', async () => {
    const { mount: current } = make();
    key('PageUp');
    expect(current.orbit.target[1]).toBeCloseTo(1.1, 10);
    const glide = current.orbit.glideTo([0, 2.5, 4], [0, 1.5, 0], 300);
    key('Home');
    current.update(100);
    await glide;
    expect(current.orbit.target).toEqual(PROOF_VIEW.target);
    expect(current.orbit.position[1]).toBeCloseTo(PROOF_VIEW.position[1], 10);
    expect(current.orbit.moving).toBe(false);
  });

  it.each(['setPose', 'moveTo', 'placeAt', 'glideTo'] as const)(
    '%s restores the supplied target height after a pan', async (method) => {
      const { mount: current } = make();
      key('PageUp');
      expect(current.orbit.target[1]).toBeCloseTo(1.1, 10);
      if (method === 'glideTo') {
        const arrived = current.orbit.glideTo(PROOF_VIEW.position, PROOF_VIEW.target, 300);
        for (let frame = 0; frame < 3; frame += 1) current.update(100);
        await arrived;
      } else current.orbit[method](PROOF_VIEW.position, PROOF_VIEW.target);
      expect(current.orbit.target).toEqual(PROOF_VIEW.target);
    },
  );

  it('presets restore their authored height including the inlay view', async () => {
    const inlay = { position: [0, 3.8, 1.8] as [number, number, number],
      target: [0, 0.1, 0] as [number, number, number], fov: 45 };
    const { mount: current } = make({ views: { proof: { ...PROOF_VIEW, fov: 40 }, inlay } });
    key('PageUp');
    expect(current.orbit.target[1]).toBeCloseTo(1.1, 10);
    await current.presets.goTo('inlay', 0);
    expect(current.orbit.target).toEqual(inlay.target);
    await current.presets.goTo('proof', 0);
    expect(current.orbit.target).toEqual(PROOF_VIEW.target);
  });

  it('walk mode preserves the panned orbit height for the return to inspection', async () => {
    const { mount: current } = make();
    key('PageUp');
    expect(current.orbit.target[1]).toBeCloseTo(1.1, 10);
    const expected = current.orbit.position;
    const walking = current.setMode('walk');
    for (let frame = 0; frame < 7; frame += 1) current.update(100);
    await walking;
    const returning = current.setMode('orbit');
    for (let frame = 0; frame < 7; frame += 1) current.update(100);
    await returning;
    expect(current.orbit.target[1]).toBeCloseTo(1.1, 10);
    expect(current.orbit.position[1]).toBeCloseTo(expected[1], 10);
  });

  it('suppresses contextmenu on the canvas only and removes the listener on disposal', () => {
    const { mount: current } = make();
    const event = () => new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    const canvasMenu = event();
    canvas.dispatchEvent(canvasMenu);
    expect(canvasMenu.defaultPrevented).toBe(true);
    const outsideMenu = event();
    document.body.dispatchEvent(outsideMenu);
    expect(outsideMenu.defaultPrevented).toBe(false);
    current.dispose();
    const retiredMenu = event();
    canvas.dispatchEvent(retiredMenu);
    expect(retiredMenu.defaultPrevented).toBe(false);
  });

  it('Page keys outside the canvas and disabled inputs leave the view alone', () => {
    const { mount: current } = make();
    sizedCanvas();
    key('PageUp');
    expect(current.orbit.target[1]).toBeCloseTo(1.1, 10);
    const before = current.orbit.position;
    expect(key('PageUp', false, document.body).defaultPrevented).toBe(false);
    current.orbit.setEnabled(false);
    key('PageUp');
    pointer('pointerdown', 200);
    pointer('pointermove', 100);
    expect(current.orbit.target[1]).toBeCloseTo(1.1, 10);
    expect(current.orbit.position).toEqual(before);
  });
});
