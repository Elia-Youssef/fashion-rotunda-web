// @vitest-environment jsdom
import { BufferGeometry, PerspectiveCamera, PlaneGeometry, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWalkthrough } from '../../src/camera/walkthrough';

// Contract tests for the observable promises of the walkthrough handle: the published pose,
// the input notifications, the pointer-lock lifecycle, and the loop-facing update and moving
// signals that decide when the renderer keeps ticking.
describe('walkthrough input and pose contracts', () => {
  const MAX_PITCH = (80 * Math.PI) / 180;
  let canvas: HTMLCanvasElement;
  let camera: PerspectiveCamera;
  let floor: PlaneGeometry;
  let empty: BufferGeometry;
  let clock: { t: number };
  const active: Array<ReturnType<typeof createWalkthrough>> = [];

  beforeEach(() => {
    canvas = document.createElement('canvas');
    camera = new PerspectiveCamera(40, 1, 0.1, 100);
    floor = new PlaneGeometry(60, 60);
    floor.rotateX(-Math.PI / 2);
    empty = new BufferGeometry();
    clock = { t: 0 };
  });

  afterEach(() => {
    for (const handle of active) handle.disable();
    active.length = 0;
    vi.restoreAllMocks();
    delete (document as { pointerLockElement?: unknown }).pointerLockElement;
    delete (document as { exitPointerLock?: unknown }).exitPointerLock;
  });

  function make(options: { isTouch?: boolean; collision?: BufferGeometry } = {}) {
    const onChange = vi.fn();
    const handle = createWalkthrough({
      camera,
      element: canvas,
      collision: options.collision ?? floor,
      eyeHeight: 1.65,
      radius: 0.3,
      walkSpeed: 1.4,
      isTouch: options.isTouch ?? false,
      onChange,
      now: (): number => clock.t,
    });
    active.push(handle);
    return { handle, onChange };
  }

  function key(code: string, type: 'keydown' | 'keyup' = 'keydown'): void {
    window.dispatchEvent(new KeyboardEvent(type, { code }));
  }

  function lockPointer(): void {
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: (): HTMLElement => canvas,
    });
    // disable() exits the lock it observes; jsdom ships no exitPointerLock to call.
    if (typeof document.exitPointerLock !== 'function') {
      Object.defineProperty(document, 'exitPointerLock', {
        configurable: true,
        value: (): void => {},
      });
    }
  }

  function mouseMove(movementX: number, movementY: number): void {
    window.dispatchEvent(new MouseEvent('mousemove', { movementX, movementY }));
  }

  function spyRequestPointerLock(): ReturnType<typeof vi.fn> {
    const spy = vi.fn();
    Object.defineProperty(canvas, 'requestPointerLock', { value: spy, configurable: true });
    return spy;
  }

  function touchRect(): void {
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 200));
  }

  function pointer(type: string, id: number, x: number, y: number): void {
    canvas.dispatchEvent(
      new PointerEvent(type, {
        pointerId: id,
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        bubbles: true,
      }),
    );
  }

  function direction(): Vector3 {
    return camera.getWorldDirection(new Vector3());
  }

  it('faces the plinth from the start pose and turns with yaw', () => {
    const { handle } = make();
    handle.enable();
    expect(direction().z).toBeCloseTo(-1, 5);
    expect(direction().x).toBeCloseTo(0, 5);
    handle.setPose([0, 0, 0], Math.PI / 2, 0);
    expect(direction().x).toBeCloseTo(1, 5);
    handle.disable();
  });

  it('keeps the camera at eye height above the grounded foot while walking', () => {
    const { handle } = make();
    handle.enable();
    key('KeyW');
    expect(handle.update(100)).toBe(true);
    expect(handle.foot[1]).toBe(0);
    expect(camera.position.y).toBeCloseTo(1.65, 5);
    expect(camera.position.z).toBeCloseTo(handle.foot[2], 5);
    key('KeyW', 'keyup');
    handle.disable();
  });

  it('uses the platform clock when no now is provided', async () => {
    const onChange = vi.fn();
    const handle = createWalkthrough({
      camera,
      element: canvas,
      collision: floor,
      eyeHeight: 1.65,
      radius: 0.3,
      walkSpeed: 1.4,
      isTouch: false,
      onChange,
    });
    active.push(handle);
    handle.enable();
    key('KeyW');
    key('KeyW', 'keyup');
    expect(handle.moving).toBe(true);
    expect(handle.update(100)).toBe(true);
    // The still window must expire against the real platform clock.
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(handle.moving).toBe(false);
    expect(handle.update(100)).toBe(false);
    handle.disable();
  });

  it('ignores keys pressed while disabled', () => {
    const { handle } = make();
    key('KeyW');
    handle.enable();
    handle.update(100);
    expect(handle.foot).toEqual([0, 0, 5.5]);
    handle.disable();
  });

  it('arrow keys walk and release cleanly', () => {
    const { handle } = make();
    handle.enable();
    key('ArrowUp');
    expect(handle.update(100)).toBe(true);
    expect(handle.foot[2]).toBeCloseTo(5.36, 9);
    key('ArrowUp', 'keyup');
    handle.update(100);
    expect(handle.foot[2]).toBeCloseTo(5.36, 9);
    handle.disable();
  });

  it('KeyA strafes left and releases cleanly', () => {
    const { handle } = make();
    handle.enable();
    key('KeyA');
    handle.update(100);
    expect(handle.foot[0]).toBeCloseTo(-0.14, 9);
    key('KeyA', 'keyup');
    handle.update(100);
    expect(handle.foot[0]).toBeCloseTo(-0.14, 9);
    handle.disable();
  });

  it('arrow keys strafe and release cleanly', () => {
    const { handle } = make();
    handle.enable();
    key('ArrowLeft');
    handle.update(100);
    expect(handle.foot[0]).toBeCloseTo(-0.14, 9);
    key('ArrowLeft', 'keyup');
    handle.update(100);
    expect(handle.foot[0]).toBeCloseTo(-0.14, 9);
    handle.disable();
  });

  it('unrelated keys do not arm movement, notify, or error', () => {
    const { handle, onChange } = make();
    handle.enable();
    onChange.mockClear();
    const errors: unknown[] = [];
    const noteError = (event: ErrorEvent): void => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener('error', noteError);
    try {
      key('KeyQ');
    } finally {
      window.removeEventListener('error', noteError);
    }
    expect(errors).toEqual([]);
    expect(handle.moving).toBe(false);
    expect(handle.update(100)).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    handle.disable();
  });

  it('clears pressed keys when pointer lock is released', () => {
    const { handle } = make();
    handle.enable();
    lockPointer();
    key('KeyW');
    delete (document as { pointerLockElement?: unknown }).pointerLockElement;
    document.dispatchEvent(new Event('pointerlockchange'));
    handle.update(100);
    expect(handle.foot).toEqual([0, 0, 5.5]);
    handle.disable();
  });

  it('does not rotate on mouse movement without pointer lock', () => {
    const { handle, onChange } = make();
    handle.enable();
    mouseMove(25, -10);
    expect(handle.yaw).toBe(0);
    expect(handle.pitch).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
    handle.disable();
  });

  it('rotates with pointer-locked mouse movement', () => {
    const { handle, onChange } = make();
    handle.enable();
    lockPointer();
    onChange.mockClear();
    mouseMove(10, 0);
    expect(handle.yaw).toBeCloseTo(0.05, 6);
    mouseMove(0, 8);
    expect(handle.pitch).toBeCloseTo(-0.04, 6);
    expect(onChange).toHaveBeenCalled();
    expect(handle.update(100)).toBe(true);
    handle.disable();
  });

  it('clamps pitch during pointer-locked mouse look', () => {
    const { handle } = make();
    handle.enable();
    lockPointer();
    for (let i = 0; i < 100; i += 1) mouseMove(0, -50);
    expect(handle.pitch).toBeCloseTo(MAX_PITCH, 6);
    for (let i = 0; i < 200; i += 1) mouseMove(0, 50);
    expect(handle.pitch).toBeCloseTo(-MAX_PITCH, 6);
    handle.disable();
  });

  it('requests pointer lock on desktop click only while unlocked', () => {
    const { handle } = make();
    const request = spyRequestPointerLock();
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(request).not.toHaveBeenCalled();
    handle.enable();
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(request).toHaveBeenCalledTimes(1);
    lockPointer();
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(request).toHaveBeenCalledTimes(1);
    handle.disable();
  });

  it('never requests pointer lock on touch', () => {
    const { handle } = make({ isTouch: true });
    const request = spyRequestPointerLock();
    handle.enable();
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(request).not.toHaveBeenCalled();
    handle.disable();
  });

  it('exits pointer lock on disable', () => {
    const { handle } = make();
    handle.enable();
    lockPointer();
    const exit = vi.fn();
    Object.defineProperty(document, 'exitPointerLock', { value: exit, configurable: true });
    handle.disable();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('starts look drags only on the right half of the viewport', () => {
    const { handle } = make({ isTouch: true });
    touchRect();
    handle.enable();
    pointer('pointerdown', 7, 100, 100);
    pointer('pointermove', 7, 120, 100);
    expect(handle.yaw).toBe(0);
    pointer('pointerdown', 8, 300, 100);
    pointer('pointermove', 8, 320, 100);
    expect(handle.yaw).toBeCloseTo(0.1, 6);
    pointer('pointerup', 8, 320, 100);
    handle.disable();
  });

  it('ignores moves from pointers that did not start the drag', () => {
    const { handle } = make({ isTouch: true });
    touchRect();
    handle.enable();
    pointer('pointerdown', 7, 300, 100);
    pointer('pointermove', 8, 360, 100);
    expect(handle.yaw).toBe(0);
    pointer('pointermove', 7, 320, 100);
    expect(handle.yaw).toBeCloseTo(0.1, 6);
    pointer('pointerup', 7, 320, 100);
    handle.disable();
  });

  it('keeps the first finger owning the look drag', () => {
    const { handle } = make({ isTouch: true });
    touchRect();
    handle.enable();
    pointer('pointerdown', 7, 300, 100);
    pointer('pointerdown', 8, 350, 120);
    pointer('pointermove', 8, 380, 120);
    expect(handle.yaw).toBe(0);
    pointer('pointermove', 7, 320, 100);
    expect(handle.yaw).toBeCloseTo(0.1, 6);
    pointer('pointerup', 7, 320, 100);
    handle.disable();
  });

  it('a foreign pointerup does not end the look drag', () => {
    const { handle } = make({ isTouch: true });
    touchRect();
    handle.enable();
    pointer('pointerdown', 7, 300, 100);
    pointer('pointerup', 8, 300, 100);
    pointer('pointermove', 7, 320, 100);
    expect(handle.yaw).toBeCloseTo(0.1, 6);
    pointer('pointerup', 7, 320, 100);
    handle.disable();
  });

  it('drag look turns, clamps pitch, applies the pose and notifies', () => {
    const { handle, onChange } = make({ isTouch: true });
    touchRect();
    handle.enable();
    onChange.mockClear();
    pointer('pointerdown', 7, 300, 100);
    pointer('pointermove', 7, 360, 96);
    expect(handle.yaw).toBeCloseTo(0.3, 6);
    expect(handle.pitch).toBeCloseTo(0.02, 6);
    expect(onChange).toHaveBeenCalled();
    expect(direction().x).toBeGreaterThan(0.2);
    for (let i = 1; i <= 100; i += 1) pointer('pointermove', 7, 360, 56 - 20 * i);
    expect(handle.pitch).toBeCloseTo(MAX_PITCH, 6);
    pointer('pointerup', 7, 360, 56 - 2000);
    handle.disable();
  });

  it('walks freely with collision-free geometry', () => {
    const { handle } = make({ collision: empty });
    handle.enable();
    key('KeyW');
    expect(handle.update(100)).toBe(true);
    expect(handle.foot[2]).toBeCloseTo(5.36, 9);
    key('KeyW', 'keyup');
    handle.disable();
  });

  it('joystick vector drives forward and sideways walking', () => {
    const { handle } = make();
    handle.enable();
    handle.setJoystickVector(0, 1);
    expect(handle.update(100)).toBe(true);
    expect(handle.foot[2]).toBeCloseTo(5.36, 9);
    handle.setJoystickVector(0, 0);
    handle.setPose([0, 0, 5.5], 0, 0);
    handle.setJoystickVector(1, 0);
    handle.update(100);
    expect(handle.foot[0]).toBeCloseTo(0.14, 9);
    handle.setJoystickVector(0, 0);
    handle.disable();
  });

  it('caps each step to 100 ms and ignores negative steps', () => {
    const { handle } = make();
    handle.enable();
    key('KeyW');
    handle.update(2000);
    expect(handle.foot[2]).toBeCloseTo(5.36, 9);
    handle.setPose([0, 0, 5.5], 0, 0);
    handle.update(-5000);
    expect(handle.foot[2]).toBeCloseTo(5.5, 9);
    key('KeyW', 'keyup');
    handle.disable();
  });

  it('doubles speed with either shift key', () => {
    const { handle } = make();
    handle.enable();
    key('ShiftRight');
    key('KeyW');
    handle.update(100);
    handle.update(100);
    expect(handle.foot[2]).toBeCloseTo(5.5 - 0.56, 9);
    key('KeyW', 'keyup');
    key('ShiftRight', 'keyup');
    handle.disable();
  });

  it('update is inert while disabled', () => {
    const { handle, onChange } = make();
    handle.enable();
    handle.disable();
    handle.setJoystickVector(0, 1);
    onChange.mockClear();
    expect(handle.update(100)).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(handle.foot).toEqual([0, 0, 5.5]);
    expect(camera.position.z).toBeCloseTo(5.5, 9);
    handle.setJoystickVector(0, 0);
  });

  it('reports the still window around ended input', () => {
    const { handle } = make();
    handle.enable();
    key('KeyW');
    clock.t = 100;
    handle.update(100);
    clock.t = 200;
    handle.update(100);
    key('KeyW', 'keyup');
    clock.t = 250;
    expect(handle.update(100)).toBe(true);
    expect(handle.moving).toBe(true);
    clock.t = 270;
    expect(handle.update(100)).toBe(false);
    expect(handle.moving).toBe(false);
    handle.disable();
  });

  it('moving reflects held keys and joystick vectors past the still window', () => {
    const { handle } = make();
    handle.enable();
    key('KeyW');
    clock.t = 1000;
    expect(handle.moving).toBe(true);
    key('KeyW', 'keyup');
    clock.t = 2000;
    expect(handle.moving).toBe(false);
    handle.setJoystickVector(1, 0);
    clock.t = 3000;
    expect(handle.moving).toBe(true);
    handle.setJoystickVector(0, 0);
    handle.disable();
  });

  it('moving reflects an active look drag past the still window', () => {
    const { handle } = make({ isTouch: true });
    touchRect();
    handle.enable();
    pointer('pointerdown', 7, 300, 100);
    clock.t = 1000;
    expect(handle.moving).toBe(true);
    pointer('pointerup', 7, 300, 100);
    handle.disable();
  });

  it('notifies joystick input only for nonzero vectors', () => {
    const { handle, onChange } = make();
    handle.enable();
    handle.setJoystickVector(0, 0);
    expect(onChange).not.toHaveBeenCalled();
    handle.setJoystickVector(1, 0);
    expect(onChange).toHaveBeenCalledTimes(1);
    handle.setJoystickVector(0, 0);
    handle.disable();
  });

  it('notifies change for every walking update', () => {
    const { handle, onChange } = make();
    handle.enable();
    key('KeyW');
    onChange.mockClear();
    handle.update(100);
    expect(onChange).toHaveBeenCalledTimes(1);
    key('KeyW', 'keyup');
    handle.disable();
  });

  it('disable clears pressed keys for the next enable', () => {
    const { handle } = make();
    handle.enable();
    key('KeyW');
    handle.disable();
    handle.enable();
    handle.update(100);
    expect(handle.foot).toEqual([0, 0, 5.5]);
    handle.disable();
  });

  it('disable clears an interrupted look drag', () => {
    const { handle } = make({ isTouch: true });
    touchRect();
    handle.enable();
    pointer('pointerdown', 7, 300, 100);
    handle.disable();
    handle.enable();
    pointer('pointerdown', 8, 300, 100);
    pointer('pointermove', 8, 320, 100);
    expect(handle.yaw).toBeCloseTo(0.1, 6);
    pointer('pointerup', 8, 320, 100);
    handle.disable();
  });

  it('a second disable leaves armed input alone', () => {
    const { handle } = make();
    handle.enable();
    handle.disable();
    handle.setJoystickVector(0.5, 0);
    handle.disable();
    handle.enable();
    handle.update(100);
    expect(handle.foot[0]).toBeCloseTo(0.07, 9);
    handle.setJoystickVector(0, 0);
    handle.disable();
  });

  it('setPose moves the camera only while enabled but always notifies', () => {
    const { handle, onChange } = make();
    handle.setPose([3, 0, 7], 0.5, 0.2);
    expect(handle.foot).toEqual([3, 0, 7]);
    expect(handle.yaw).toBeCloseTo(0.5, 6);
    expect(camera.position.x).toBeCloseTo(0, 9);
    expect(onChange).toHaveBeenCalledTimes(1);
    handle.enable();
    expect(camera.position.x).toBeCloseTo(3, 5);
    expect(camera.position.y).toBeCloseTo(1.65, 5);
    expect(camera.position.z).toBeCloseTo(7, 5);
    handle.disable();
  });

  it('foot returns a private copy', () => {
    const { handle } = make();
    const foot = handle.foot;
    foot[0] = -100;
    foot[2] = -100;
    expect(handle.foot).toEqual([0, 0, 5.5]);
  });

  it('dispose stops input handling', () => {
    const { handle } = make();
    handle.enable();
    handle.dispose();
    expect(handle.enabled).toBe(false);
    key('KeyW');
    expect(handle.update(100)).toBe(false);
    expect(handle.foot).toEqual([0, 0, 5.5]);
  });
});
