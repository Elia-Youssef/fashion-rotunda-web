// Goal G4.1 + G4.4 wiring: the one place the camera code touches the page. The showroom's camera
// and look, the render loop and the catalogue's proof view come together here; main.ts adds a
// single mountCamera call at its hook and drives update(dtMs) from the loop's render
// callback. Everything the orbit and the turntable need from the page is passed in, so they stay
// testable without a renderer.

import type { PerspectiveCamera } from 'three/webgpu';

import { createOrbit } from './orbit';
import type { OrbitHandle, OrbitLimits } from './orbit';
import { createTurntable } from './turntable';
import type { Turntable } from './turntable';

export interface CameraMountOptions {
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
  showroom: { setLookYaw(radians: number): void; readonly lookYaw: number };
  loop: { invalidate(): void; setAnimating(on: boolean): void };
  proofView: { position: [number, number, number]; target: [number, number, number] };
}

export interface CameraMount {
  orbit: OrbitHandle;
  turntable: Turntable;
  /** Call from the loop's render callback with the frame's dt: drives damping and the turntable. */
  update(dtMs: number): void;
  /**
   * True while the orbit glides or the turntable runs: what main.ts's wake window asks before it
   * switches the loop off.
   */
  readonly moving: boolean;
  dispose(): void;
}

/** Inside the rotunda, above the floor, off the zenith: the room is about 16 m across. */
const LIMITS: OrbitLimits = {
  minDistance: 1.2,
  maxDistance: 7,
  minPolar: 0.15,
  maxPolar: Math.PI / 2 - 0.05,
};
/** The per-frame fraction of remaining motion the orbit sheds at 60 Hz. */
const DAMPING = 0.12;
const TURNTABLE_DEGREES_PER_SECOND = 20;
/**
 * The loop's dt is the time since the last drawn frame, idle time included: the first frame after
 * a still page carries the whole gap, and the turntable would replay every idle second as an
 * instant jump the moment it is switched on. One frame's worth at most may advance anything here;
 * on a slow machine the motion falls behind wall time instead of teleporting, which is the lesser
 * evil on a page whose whole point is looking at the thing.
 */
const MAX_STEP_MS = 100;

declare global {
  interface Window {
    /**
     * Test-only handle, mounted behind the same gate as window.archvizE2E in main.ts: dev builds
     * and `?e2e=1`. The e2e suite drags the camera and toggles the turntable through it, which no
     * visitor-facing control can do until G5.1 mounts the product card.
     */
    archvizCamera?: { orbit: OrbitHandle; turntable: Turntable };
  }
}

export function mountCamera(options: CameraMountOptions): CameraMount {
  const { camera, canvas, showroom, loop, proofView } = options;

  const hadTouchAction = canvas.style.touchAction;
  // One finger belongs to the orbit, not to the page scroll; restored on dispose.
  canvas.style.touchAction = 'none';
  // The attribute, not the IDL property: canvas.tabIndex reads -1 when no attribute is set, so
  // restoring the property would leave a tabindex="-1" behind that was never there.
  const hadTabIndex = canvas.getAttribute('tabindex');
  // Keys reach the canvas only while it can hold focus.
  canvas.tabIndex = 0;

  // True while this mount has asked the loop for continuous frames. Guards the settle path so
  // setAnimating(false) is called exactly once per motion, not once per frame.
  let holding = false;
  let appliedYaw = showroom.lookYaw;

  function writeYaw(yaw: number): void {
    appliedYaw = yaw;
    showroom.setLookYaw(yaw);
    // Readable from outside without exposing the showroom: the e2e suite watches this attribute.
    canvas.dataset.yaw = yaw.toFixed(3);
  }

  function hold(): void {
    // Re-asserted on every call, not only the first: main.ts's wake window writes the same flag
    // on its own four-second timer and the loop's animating flag is last writer wins. The loop
    // treats a repeat setAnimating(true) as a no-op once a frame is already scheduled.
    loop.setAnimating(true);
    if (holding) {
      return;
    }
    holding = true;
  }

  function release(): void {
    if (!holding) {
      return;
    }
    holding = false;
    loop.setAnimating(false);
  }

  // Neither createOrbit nor createTurntable fires onChange during construction, so these closures
  // can name the handles they belong to; the first onChange comes from setPose below, after both
  // handles exist.
  const orbit = createOrbit({
    camera,
    element: canvas,
    target: proofView.target,
    limits: LIMITS,
    damping: DAMPING,
    onChange: () => {
      if (orbit.moving) {
        hold();
      } else {
        // An instant change (a wheel notch, a key step): one frame shows it.
        loop.invalidate();
      }
    },
  });

  const turntable = createTurntable({
    degreesPerSecond: TURNTABLE_DEGREES_PER_SECOND,
    onChange: () => {
      if (turntable.running) {
        hold();
      } else if (showroom.lookYaw !== turntable.yaw) {
        // Stopped, and the yaw moved anyway: setYaw, the Reset action putting the look back.
        writeYaw(turntable.yaw);
        loop.invalidate();
      }
    },
  });

  // The pose the page starts at and the one Home and reset() return to.
  orbit.setPose(proofView.position, proofView.target);

  const exposed = import.meta.env.DEV || new URLSearchParams(window.location.search).get('e2e') === '1';
  if (exposed) {
    window.archvizCamera = { orbit, turntable };
  }

  return {
    orbit,
    turntable,

    update(dtMs: number): void {
      const step = Math.min(Math.max(dtMs, 0), MAX_STEP_MS);
      const orbitMoving = orbit.update(step);
      const yaw = turntable.update(step);
      // While stopped the update returns the held yaw and notifies nothing; the look stays put.
      if (turntable.running && yaw !== appliedYaw) {
        writeYaw(yaw);
      }
      if (!orbitMoving && !turntable.running) {
        release();
      }
    },

    get moving(): boolean {
      return orbit.moving || turntable.running;
    },

    dispose(): void {
      release();
      orbit.dispose();
      turntable.stop();
      canvas.style.touchAction = hadTouchAction;
      if (hadTabIndex === null) {
        canvas.removeAttribute('tabindex');
      } else {
        canvas.setAttribute('tabindex', hadTabIndex);
      }
      delete canvas.dataset.yaw;
      if (window.archvizCamera?.orbit === orbit) {
        delete window.archvizCamera;
      }
    },
  };
}
