// @vitest-environment jsdom
import { BufferGeometry, PerspectiveCamera } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountJoystick } from '../../src/camera/joystick';
import { createOrbit } from '../../src/camera/orbit';
import { createWalkthrough } from '../../src/camera/walkthrough';
import { capturePointer, releasePointer } from '../../src/camera/pointer-capture';

// Distinct IDs prove a failed release does not strand the next gesture.
const FIRST_POINTER = 17;
const NEXT_POINTER = 18;
const START_X = 300;
const START_Y = 100;

interface Control {
  element: HTMLElement;
  state(): number[];
  dispose(): void;
}

const controls: Array<{ name: string; create(): Control }> = [
  { name: 'joystick', create: () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let vector = [0, 0];
    const handle = mountJoystick(root, (x, y) => { vector = [x, y]; });
    handle.setVisible(true);
    const element = root.querySelector<HTMLElement>('.archviz-joystick-base')!;
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 400, 200));
    return { element, state: () => [...vector], dispose: () => { handle.dispose(); root.remove(); } };
  } },
  { name: 'orbit', create: () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const camera = new PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 1.7, 4.2);
    const handle = createOrbit({ camera, element, target: [0, 1, 0], damping: 0,
      limits: { minDistance: 1.2, maxDistance: 7, minPolar: 0.15, maxPolar: 1.5 }, onChange: () => {} });
    return { element, state: () => [...handle.position], dispose: () => { handle.dispose(); element.remove(); } };
  } },
  { name: 'walkthrough', create: () => {
    const element = document.createElement('canvas');
    document.body.appendChild(element);
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 200));
    const collision = new BufferGeometry();
    const handle = createWalkthrough({ camera: new PerspectiveCamera(40, 1, 0.1, 100), element,
      collision, eyeHeight: 1.65, radius: 0.3, walkSpeed: 1.4, isTouch: true, onChange: () => {} });
    handle.enable();
    return { element, state: () => [handle.yaw, handle.pitch],
      dispose: () => { handle.dispose(); collision.dispose(); element.remove(); } };
  } },
];

let mounted: Control[];
let errors: unknown[];
function noteError(event: ErrorEvent): void {
  errors.push(event.error);
  // DOM dispatch reports handler exceptions on window instead of throwing from dispatchEvent.
  // Record the real exception for assertion and prevent an unrelated unhandled-test report.
  event.preventDefault();
}
beforeEach(() => {
  mounted = [];
  errors = [];
  window.addEventListener('error', noteError);
});

describe('pointer capture compatibility', () => {
  it.each(['NotFoundError', 'InvalidStateError'])('contains %s for both native operations', (name) => {
    const element = document.createElement('div');
    const unavailable = (): never => { throw new DOMException('pointer unavailable', name); };
    Object.defineProperties(element, {
      setPointerCapture: { value: unavailable },
      releasePointerCapture: { value: unavailable },
      hasPointerCapture: { value: () => true },
    });
    expect(capturePointer(element, FIRST_POINTER)).toBe(false);
    expect(() => releasePointer(element, FIRST_POINTER)).not.toThrow();
  });

  it('surfaces name-only lookalikes that are not DOMExceptions', () => {
    // Only genuine DOMException signals of a dead pointer are tolerated; an ordinary error
    // that happens to carry the same name must stay visible to the caller.
    const element = document.createElement('div');
    const lookalike = Object.assign(new Error('name-only pointer signal'), { name: 'NotFoundError' });
    const failed = (): never => { throw lookalike; };
    Object.defineProperties(element, {
      setPointerCapture: { value: failed },
      releasePointerCapture: { value: failed },
      hasPointerCapture: { value: () => true },
    });
    expect(() => capturePointer(element, FIRST_POINTER)).toThrow(lookalike);
    expect(() => releasePointer(element, FIRST_POINTER)).toThrow(lookalike);
  });

  it('skips unavailable APIs and releases through an API without an ownership query', () => {
    const element = document.createElement('div');
    Object.defineProperties(element, {
      setPointerCapture: { value: undefined, configurable: true },
      releasePointerCapture: { value: undefined, configurable: true },
      hasPointerCapture: { value: undefined },
    });
    expect(capturePointer(element, FIRST_POINTER)).toBe(false);
    expect(() => releasePointer(element, FIRST_POINTER)).not.toThrow();
    const release = vi.fn();
    Object.defineProperty(element, 'releasePointerCapture', { value: release });
    releasePointer(element, FIRST_POINTER);
    expect(release).toHaveBeenCalledWith(FIRST_POINTER);
  });

  it('keeps unrelated capture and release failures visible', () => {
    const element = document.createElement('div');
    const failed = (): never => { throw new TypeError('unexpected implementation defect'); };
    Object.defineProperties(element, {
      setPointerCapture: { value: failed },
      releasePointerCapture: { value: failed },
      hasPointerCapture: { value: () => true },
    });
    expect(() => capturePointer(element, FIRST_POINTER)).toThrow('unexpected implementation defect');
    expect(() => releasePointer(element, FIRST_POINTER)).toThrow('unexpected implementation defect');
  });
});
afterEach(() => {
  for (const control of mounted) control.dispose();
  window.removeEventListener('error', noteError);
  vi.restoreAllMocks();
});

function pointer(control: Control, type: string, id = FIRST_POINTER, dx = 0, dy = 0): void {
  control.element.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch',
    button: 0, clientX: START_X + dx, clientY: START_Y + dy, bubbles: true }));
}

describe.each(controls)('$name pointer capture', ({ create }) => {
  function setup(captureLost = false, releaseLost = false, held = true) {
    const control = create();
    mounted.push(control);
    const set = vi.fn(() => {
      if (captureLost) throw new DOMException('No active pointer with the given id', 'NotFoundError');
    });
    const release = vi.fn(() => {
      if (releaseLost) throw new DOMException('No active pointer with the given id', 'NotFoundError');
    });
    const has = vi.fn(() => held);
    Object.defineProperties(control.element, {
      setPointerCapture: { value: set, configurable: true },
      releasePointerCapture: { value: release, configurable: true },
      hasPointerCapture: { value: has, configurable: true },
    });
    return { control, set, release, has };
  }

  it('contains NotFoundError from capture and still applies drag coordinates', () => {
    const { control, set } = setup(true, false, false);
    const before = control.state();
    pointer(control, 'pointerdown');
    pointer(control, 'pointermove', FIRST_POINTER, 20, -10);
    expect(set).toHaveBeenCalledWith(FIRST_POINTER);
    expect(errors, 'capture exceptions must not escape the handler').toEqual([]);
    expect(control.state(), 'coordinate-driven motion survives unavailable capture').not.toEqual(before);
    pointer(control, 'pointerup');
    expect(errors).toEqual([]);
  });

  it('skips release for an inactive pointer and allows another gesture', () => {
    const { control, release } = setup(false, true, false);
    pointer(control, 'pointerdown');
    pointer(control, 'pointermove', FIRST_POINTER, 20, -10);
    pointer(control, 'pointercancel');
    expect(errors, 'inactive release must not escape the handler').toEqual([]);
    expect(release).not.toHaveBeenCalled();
    const afterRelease = control.state();
    pointer(control, 'pointerdown', NEXT_POINTER);
    pointer(control, 'pointermove', NEXT_POINTER, 30, -20);
    expect(control.state(), 'cancellation clears the previous pointer').not.toEqual(afterRelease);
    pointer(control, 'pointerup', NEXT_POINTER);
  });

  it('contains a release race after hasPointerCapture and allows another gesture', () => {
    const { control, release, has } = setup(false, true, true);
    pointer(control, 'pointerdown');
    pointer(control, 'pointermove', FIRST_POINTER, 20, -10);
    pointer(control, 'pointerup');
    expect(errors, 'a release race must not escape the handler').toEqual([]);
    expect(has).toHaveBeenCalledWith(FIRST_POINTER);
    expect(release).toHaveBeenCalledWith(FIRST_POINTER);
    const afterRelease = control.state();
    pointer(control, 'pointerdown', NEXT_POINTER);
    pointer(control, 'pointermove', NEXT_POINTER, 30, -20);
    expect(control.state()).not.toEqual(afterRelease);
    pointer(control, 'pointerup', NEXT_POINTER);
    expect(errors).toEqual([]);
  });

  it('keeps native capture and release for an active pointer', () => {
    const { control, set, release } = setup();
    pointer(control, 'pointerdown');
    pointer(control, 'pointermove', FIRST_POINTER, 20, -10);
    pointer(control, 'pointerup');
    expect(set).toHaveBeenCalledWith(FIRST_POINTER);
    expect(release).toHaveBeenCalledWith(FIRST_POINTER);
    expect(errors).toEqual([]);
  });
});
