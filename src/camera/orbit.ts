// The inspection camera. Orbits the target by drag, dollies by wheel, pinch and keys,
// and glides to rest after release through the page's own on-demand loop (onChange asks for the
// frame, update integrates the damping). Written against three.js primitives directly: the addon
// OrbitControls owns pointer events and schedules its own animation frames, which this page's
// render loop cannot hand over. The spherical convention is three's own: phi is the angle from
// +y and theta is atan2(x, z), so a yaw of 0 puts the camera on the +z side of the target, which is
// the proof pose.

import { MathUtils, Spherical, Vector3 } from 'three/webgpu';
import type { PerspectiveCamera } from 'three/webgpu';
import { prefersReducedMotion } from '../ui/announce';
import { capturePointer, releasePointer } from './pointer-capture';

export interface OrbitLimits {
  minDistance: number; // metres from the target
  maxDistance: number;
  minPolar: number; // radians from straight up; 0.15 keeps the camera off the zenith
  maxPolar: number; // Math.PI / 2 - 0.05 keeps it above the floor
}

export interface OrbitOptions {
  camera: PerspectiveCamera;
  /** the canvas: pointer, wheel and key events bind here */
  element: HTMLElement;
  target: [number, number, number];
  limits: OrbitLimits;
  /** 0 (none) to 1; the per-frame fraction of the remaining motion */
  damping: number;
  /** the caller invalidates the loop */
  onChange: () => void;
  /** The clock the stale-release guard reads, injectable so the unit tests drive it by hand. */
  now?: () => number;
}

export interface OrbitHandle {
  /** Integrates damping; true while the camera is still moving. */
  update(dtMs: number): boolean;
  setPose(position: [number, number, number], target: [number, number, number], fov?: number): void;
  /**
   * Moves to a pose without making it the one reset() returns to: a pose that arrives in a link
   * is the visitor's own, and Reset still means the view the page was built with.
   */
  moveTo(position: [number, number, number], target: [number, number, number], fov?: number): void;
  /**
   * Smoothly eases to a pose over ms (0 ms is instantaneous). Respects limits and resolves on arrival.
   */
  glideTo(
    position: [number, number, number],
    target: [number, number, number],
    ms?: number,
    fov?: number,
  ): Promise<void>;
  /**
   * Places the camera at a pose immediately, like moveTo, without becoming the pose reset()
   * returns to. Runs on math workspace this control owns: no Vector3, no Spherical and no
   * promise are constructed per call, so per-frame callers (the attract tour, the proof orbit)
   * allocate nothing here. Clamps to the limits and finishes any glide in flight.
   */
  placeAt(position: [number, number, number], target: [number, number, number], fov?: number): void;
  /** Enables or disables input processing. */
  setEnabled(on: boolean): void;
  /** back to the pose it was created or last setPose'd with */
  reset(): void;
  readonly moving: boolean;
  /** The camera's position in metres; the e2e suite reads it through window.archvizCamera. */
  readonly position: [number, number, number];
  /** The orbit's target in metres. */
  readonly target: [number, number, number];
  /** The live vertical perspective FOV in degrees. */
  readonly fov: number;
  /** removes every listener it added */
  dispose(): void;
}

/** Radians of yaw per pixel of drag: about 630 pixels to a half turn, the Unreal feel. */
const ROTATE_PER_PIXEL = 0.005;
/** One wheel notch dollies by this factor; the sign of deltaY picks in or out. */
const DOLLY_PER_NOTCH = 1.1;
/** A mouse wheel notch reports 100 pixels of deltaY in the DOM_DELTA_PIXEL mode browsers send. */
const PIXELS_PER_NOTCH = 100;
/** The frame the damping constant is expressed against: 60 Hz. */
const FRAME_MS = 16.7;
/** Below this the glide is over, in radians (and metres, were the dolly damped; it is instant). */
const STILL_EPSILON = 1e-4;
/** One keydown rotates by three degrees, so a held key repeats into a steady pan. */
const KEY_ROTATE = Math.PI / 60;
/**
 * A release this long after the last pointer move is a release from rest: the hand held the
 * subject still and then let go, so there is no velocity to carry and the armed glide is dropped.
 * Below it the last move is the release velocity and the glide runs.
 */
const STALE_RELEASE_MS = 80;

/** One pointer this control has grabbed: its last known position. */
interface TrackedPointer {
  x: number;
  y: number;
}

export function createOrbit(options: OrbitOptions): OrbitHandle {
  const camera = options.camera;
  const element = options.element;
  const limits = options.limits;
  // A damping of exactly 1 divides by log(0) below; anything past it grows instead of decaying.
  const damping = MathUtils.clamp(options.damping, 0, 0.999999);
  const onChange = options.onChange;
  // Bound, because performance.now() thrown about unbound is an illegal invocation in the browsers.
  const now = options.now ?? ((): number => performance.now());

  const target = new Vector3(...options.target);
  const spherical = new Spherical().setFromVector3(new Vector3().copy(camera.position).sub(target));
  // What reset() goes back to: the pose at construction, replaced by every setPose.
  const resetSpherical = spherical.clone();
  const resetTarget = target.clone();

  // The glide: radians per FRAME_MS still owed. Drag moves replace it (the last move is the
  // release velocity); update drains it geometrically. Zero means still.
  let pendingTheta = 0;
  let pendingPhi = 0;

  const pointers = new Map<number, TrackedPointer>();
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  // When the last pointer move actually moved the camera; the release reads it against
  // STALE_RELEASE_MS. Negative infinity so a release before any move is stale by construction.
  let lastMoveMs = Number.NEGATIVE_INFINITY;
  let pinchSpread = 0;
  let capturedPointer: number | null = null;
  let isEnabled = true;

  interface ActiveGlide {
    startPos: Vector3;
    startTarget: Vector3;
    destPos: Vector3;
    destTarget: Vector3;
    startFov: number;
    destFov: number;
    durationMs: number;
    elapsedMs: number;
    resolve: () => void;
  }
  let activeGlide: ActiveGlide | null = null;
  // Interpolation must never mutate the glide endpoints, or another control's workspace.
  const glidePosition = new Vector3();
  const glideTarget = new Vector3();

  // Scratch for the synchronous pose paths (placeAt, setPose): the attract tour and the proof
  // orbit apply a pose every frame, so those paths construct no Vector3 and no Spherical.
  const scratchTarget = new Vector3();
  const scratchOffset = new Vector3();
  const scratchSpherical = new Spherical();

  /** Resolves and forgets the glide in flight, if any. Shared by every path that supersedes one. */
  function finishGlide(): void {
    if (activeGlide !== null) {
      const finish = activeGlide.resolve;
      activeGlide = null;
      finish();
    }
  }

  /**
   * Applies a pose immediately from the scratch workspace: target and clamped spherical into
   * the live state, optional fov, one apply. The caller has finished writing the scratch first,
   * so a re-entrant pose change from onChange cannot see half-written scratch.
   */
  function applyImmediate(fov: number | undefined, withResetAnchor: boolean): void {
    target.copy(scratchTarget);
    spherical.copy(scratchSpherical);
    if (withResetAnchor) {
      resetSpherical.copy(spherical);
      resetTarget.copy(target);
    }
    pendingTheta = 0;
    pendingPhi = 0;
    if (fov !== undefined) {
      applyFov(fov);
    }
    apply();
  }

  /** Reads a position and target into the scratch and clamps the resulting spherical. */
  function readPoseIntoScratch(
    position: [number, number, number],
    poseTarget: [number, number, number],
  ): void {
    scratchTarget.set(poseTarget[0], poseTarget[1], poseTarget[2]);
    scratchOffset.set(position[0], position[1], position[2]).sub(scratchTarget);
    scratchSpherical.setFromVector3(scratchOffset);
    scratchSpherical.phi = clampPhi(scratchSpherical.phi);
    scratchSpherical.radius = clampDistance(scratchSpherical.radius);
  }

  function clampPhi(phi: number): number {
    return MathUtils.clamp(phi, limits.minPolar, limits.maxPolar);
  }

  function clampDistance(distance: number): number {
    return MathUtils.clamp(distance, limits.minDistance, limits.maxDistance);
  }

  function clampFov(fov: number): number {
    return MathUtils.clamp(fov, 1, 179);
  }

  function applyFov(fov: number): void {
    const next = clampFov(fov);
    if (camera.fov !== next) {
      camera.fov = next;
      camera.updateProjectionMatrix();
    }
  }

  function apply(): void {
    spherical.phi = clampPhi(spherical.phi);
    spherical.radius = clampDistance(spherical.radius);
    camera.position.setFromSphericalCoords(spherical.radius, spherical.phi, spherical.theta).add(target);
    camera.lookAt(target);
    onChange();
  }

  /**
   * Rotates by the given deltas and, when arm is set, hands the applied amount to the glide so a
   * released drag keeps moving. The applied amount, not the raw input, is what glides: at a polar
   * limit the applied amount is zero and the glide dies there instead of pressing against it.
   */
  function rotateBy(dTheta: number, dPhi: number, arm: boolean): void {
    const nextPhi = clampPhi(spherical.phi + dPhi);
    const appliedPhi = nextPhi - spherical.phi;
    spherical.theta += dTheta;
    spherical.phi = nextPhi;
    if (arm && damping > 0) {
      pendingTheta = dTheta;
      pendingPhi = appliedPhi;
    }
    apply();
  }

  function dollyBy(factor: number): void {
    spherical.radius = clampDistance(spherical.radius * factor);
    apply();
  }

  function capture(pointerId: number): void {
    // A drag that leaves the canvas must keep delivering moves to it; jsdom has no pointer
    // capture, and the unit tests dispatch their events on the element directly anyway.
    if (capturePointer(element, pointerId)) {
      capturedPointer = pointerId;
    }
  }

  function releaseCapture(pointerId: number): void {
    if (capturedPointer !== pointerId) {
      return;
    }
    capturedPointer = null;
    releasePointer(element, pointerId);
  }

  /** The first two tracked pointers define the pinch, including when more fingers arrive. */
  function readPinchSpread(): number {
    const values = pointers.values();
    // Callers hold pointers.size >= 2 (the else of size === 1 in onPointerDown, the check in
    // onPointerMove), so the first two next() results each hold a tracked pointer.
    const a = values.next().value!;
    const b = values.next().value!;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function onPointerDown(event: PointerEvent): void {
    if (!isEnabled) {
      return;
    }
    finishGlide();
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return; // the left button only; middle and right are not inspection inputs
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      // Grabbing the subject stops whatever glide was left over from the previous gesture.
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      pendingTheta = 0;
      pendingPhi = 0;
    } else {
      // A second finger turns the rotate into a pinch; the spread it starts from is the baseline.
      dragging = false;
      pendingTheta = 0;
      pendingPhi = 0;
      pinchSpread = readPinchSpread();
    }
    capture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    const pointer = pointers.get(event.pointerId);
    if (!isEnabled || pointer === undefined) {
      return; // a hover, or a pointer this control never grabbed
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (pointers.size >= 2) {
      const spread = readPinchSpread();
      if (pinchSpread > 0 && spread > 0) {
        // Fingers apart dollies in, fingers together dollies out, by how much the spread changed.
        dollyBy(pinchSpread / spread);
      }
      pinchSpread = spread;
      return;
    }
    if (!dragging) {
      return;
    }
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (dx !== 0 || dy !== 0) {
      // Dragging right orbits one way and dragging left the other, as in every orbit control;
      // dragging down lifts the camera toward the zenith and dragging up drops it to the floor.
      rotateBy(-dx * ROTATE_PER_PIXEL, -dy * ROTATE_PER_PIXEL, true);
      lastMoveMs = now();
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (!pointers.delete(event.pointerId)) {
      return;
    }
    releaseCapture(event.pointerId);
    if (pointers.size === 1) {
      // The pinch is over; the surviving finger rotates again, anchored where it actually is.
      // delete() removed a pointer above and one entry remains, so next() holds that pointer.
      const remaining = pointers.values().next().value!;
      dragging = true;
      lastX = remaining.x;
      lastY = remaining.y;
      pendingTheta = 0;
      pendingPhi = 0;
    } else if (pointers.size === 0) {
      dragging = false;
      if (prefersReducedMotion() || now() - lastMoveMs > STALE_RELEASE_MS) {
        // Read the preference at release: reduced motion or a held-still drag ends at the hand's
        // final pose, without carrying the last move into an unrequested glide.
        pendingTheta = 0;
        pendingPhi = 0;
      }
      // Otherwise the last move's delta is the release velocity; the damping takes it from here.
    }
  }

  function onWheel(event: WheelEvent): void {
    if (!isEnabled) {
      return;
    }
    if (event.ctrlKey) {
      // A trackpad pinch reaches the page as ctrl plus wheel, and the browser answers it by
      // zooming the page. Dollying as well would move two things at once for the one gesture.
      return;
    }
    // Passive on purpose: the page never scrolls (overflow hidden on the body), so the default
    // action is nothing and preventDefault would only force a non-passive listener. Firefox
    // reports lines or pages, not pixels; those are scaled back to pixel notches or the dolly
    // would do almost nothing there.
    const scale = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 100 : 1;
    dollyBy(Math.pow(DOLLY_PER_NOTCH, (event.deltaY * scale) / PIXELS_PER_NOTCH));
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!isEnabled) {
      return;
    }
    // The listener sits on the canvas itself, so it only fires while the canvas holds focus.
    switch (event.key) {
      case 'ArrowLeft':
        rotateBy(KEY_ROTATE, 0, false);
        break;
      case 'ArrowRight':
        rotateBy(-KEY_ROTATE, 0, false);
        break;
      case 'ArrowUp':
        rotateBy(0, -KEY_ROTATE, false);
        break;
      case 'ArrowDown':
        rotateBy(0, KEY_ROTATE, false);
        break;
      // '+' reports as '=' unshifted on the common layouts, so both are accepted.
      case '+':
      case '=':
        dollyBy(1 / DOLLY_PER_NOTCH);
        break;
      case '-':
        dollyBy(DOLLY_PER_NOTCH);
        break;
      case 'Home':
        reset();
        break;
      default:
        break;
    }
  }

  function reset(): void {
    spherical.copy(resetSpherical);
    target.copy(resetTarget);
    pendingTheta = 0;
    pendingPhi = 0;
    apply();
  }

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);
  // A cancelled pointer (the browser took the gesture over) ends the drag exactly like a release.
  element.addEventListener('pointercancel', onPointerUp);
  element.addEventListener('wheel', onWheel, { passive: true });
  element.addEventListener('keydown', onKeyDown);

  return {
    update(dtMs: number): boolean {
      if (activeGlide !== null) {
        if (dtMs > 0) {
          activeGlide.elapsedMs += dtMs;
          const t = Math.min(1, activeGlide.elapsedMs / activeGlide.durationMs);
          const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
          const curPos = glidePosition.lerpVectors(activeGlide.startPos, activeGlide.destPos, eased);
          const curTarget = glideTarget.lerpVectors(activeGlide.startTarget, activeGlide.destTarget, eased);
          target.copy(curTarget);
          applyFov(MathUtils.lerp(activeGlide.startFov, activeGlide.destFov, eased));
          spherical.setFromVector3(curPos.sub(target));
          spherical.phi = clampPhi(spherical.phi);
          spherical.radius = clampDistance(spherical.radius);
          apply();
          if (t >= 1) {
            finishGlide();
          }
        }
        return true;
      }
      if (dragging) {
        // rotateBy has already applied every move of this drag to the spherical state. Draining
        // the glide here would apply the last move a second time, at a scale set by how many
        // pointer moves the device delivers per frame; the glide belongs to the release.
        return true;
      }
      if (pendingTheta === 0 && pendingPhi === 0) {
        return false;
      }
      if (dtMs > 0) {
        const base = 1 - damping;
        const steps = dtMs / FRAME_MS;
        const decay = Math.pow(base, steps);
        // gain is the exact integral of base^t over [0, steps], which makes the glide's total
        // independent of the frame grid: two update sequences whose dt sums match land on the
        // same pose. The naive per-frame fraction does not, and drifts by whole degrees.
        const gain = (1 - decay) / -Math.log(base);
        const nextPhi = clampPhi(spherical.phi + pendingPhi * gain);
        spherical.theta += pendingTheta * gain;
        spherical.phi = nextPhi;
        pendingTheta *= decay;
        pendingPhi *= decay;
        if (Math.abs(pendingTheta) < STILL_EPSILON && Math.abs(pendingPhi) < STILL_EPSILON) {
          pendingTheta = 0;
          pendingPhi = 0;
        }
        apply();
      }
      return pendingTheta !== 0 || pendingPhi !== 0;
    },

    setPose(position: [number, number, number], poseTarget: [number, number, number], fov?: number): void {
      finishGlide();
      readPoseIntoScratch(position, poseTarget);
      applyImmediate(fov, true);
    },

    placeAt(position: [number, number, number], poseTarget: [number, number, number], fov?: number): void {
      finishGlide();
      readPoseIntoScratch(position, poseTarget);
      // glideTo at 0 ms applies the fov even when none was given, clamping the live value; keep
      // that shape so placeAt and a zero-ms glide land on identical camera state.
      applyImmediate(fov === undefined ? camera.fov : fov, false);
    },

    glideTo(
      position: [number, number, number],
      poseTarget: [number, number, number],
      ms = 0,
      fov,
    ): Promise<void> {
      const destTarget = new Vector3(...poseTarget);
      const destSpherical = new Spherical().setFromVector3(new Vector3(...position).sub(destTarget));
      destSpherical.phi = clampPhi(destSpherical.phi);
      destSpherical.radius = clampDistance(destSpherical.radius);
      const destPos = new Vector3()
        .setFromSphericalCoords(destSpherical.radius, destSpherical.phi, destSpherical.theta)
        .add(destTarget);
      const destFov = fov === undefined ? camera.fov : clampFov(fov);

      finishGlide();

      if (ms <= 0) {
        target.copy(destTarget);
        spherical.copy(destSpherical);
        applyFov(destFov);
        pendingTheta = 0;
        pendingPhi = 0;
        apply();
        return Promise.resolve();
      }

      const startPos = new Vector3().copy(camera.position);
      const startTarget = new Vector3().copy(target);
      const startFov = camera.fov;
      pendingTheta = 0;
      pendingPhi = 0;

      return new Promise<void>((resolve) => {
        activeGlide = {
          startPos,
          startTarget,
          destPos,
          destTarget,
          startFov,
          destFov,
          durationMs: ms,
          elapsedMs: 0,
          resolve,
        };
        onChange();
      });
    },

    moveTo(position: [number, number, number], poseTarget: [number, number, number], fov?: number): void {
      this.placeAt(position, poseTarget, fov);
    },

    setEnabled(on: boolean): void {
      isEnabled = on;
      if (!on) {
        if (capturedPointer !== null) {
          releaseCapture(capturedPointer);
        }
        pointers.clear();
        dragging = false;
        pendingTheta = 0;
        pendingPhi = 0;
        finishGlide();
      }
    },

    reset,

    get moving(): boolean {
      // A held drag is motion too: the post chain drops its heavy effects to half resolution on
      // this signal, and a drag that only reported motion once it glided kept them at full.
      return dragging || pendingTheta !== 0 || pendingPhi !== 0 || activeGlide !== null;
    },

    get position(): [number, number, number] {
      return [camera.position.x, camera.position.y, camera.position.z];
    },

    get target(): [number, number, number] {
      return [target.x, target.y, target.z];
    },

    get fov(): number {
      return camera.fov;
    },

    dispose(): void {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('keydown', onKeyDown);
      if (capturedPointer !== null) {
        releaseCapture(capturedPointer);
      }
      pointers.clear();
      dragging = false;
      pendingTheta = 0;
      pendingPhi = 0;
      finishGlide();
    },
  };
}
