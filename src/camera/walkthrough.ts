// The first-person walkthrough camera.
// Navigates the rotunda floor at a constant eye height (1.65 m) with capsule collision (0.3 m radius)
// against the collision mesh. Supports pointer lock and WASD / arrow keys on desktop, and a touch
// virtual joystick and drag look on mobile. Shifts double the walk speed (1.4 m/s to 2.8 m/s).

import { MeshBVH } from 'three-mesh-bvh';
import { Vector3 } from 'three';

import { createCapsuleResolver } from './collide';
import type { CapsuleResolver } from './collide';
import type { WalkthroughHandle, WalkthroughOptions } from './contracts';
import { capturePointer, releasePointer } from './pointer-capture';

export type { WalkthroughHandle, WalkthroughOptions } from './contracts';

const ROTATE_PER_PIXEL = 0.005;
const MAX_PITCH = (80 * Math.PI) / 180;
const MAX_STEP_MS = 100;
const STILL_MOVE_MS = 60;

export function createWalkthrough(options: WalkthroughOptions): WalkthroughHandle {
  const { camera, element, collision, eyeHeight, radius, walkSpeed, isTouch, onChange } = options;
  const now = options.now ?? ((): number => performance.now());

  const hasGeometry =
    collision.getAttribute('position') !== undefined &&
    collision.getAttribute('position').count > 0;
  const bvh = hasGeometry ? new MeshBVH(collision) : null;

  // Collision workspace, owned by this walkthrough: the proposed foot vector, the capsule
  // record and the resolver are built once and reset from the input on every step, so a
  // walking step allocates nothing on the collision path.
  const proposedFoot = new Vector3();
  const resolver: CapsuleResolver | null =
    bvh !== null ? createCapsuleResolver(bvh, { radius, height: eyeHeight }) : null;

  // Starting pose: foot at [0, 0, 5.5], facing the plinth at origin.
  const foot: [number, number, number] = [0, 0, 5.5];
  let yaw = 0;
  let pitch = 0;
  let isEnabled = false;

  let fwdPressed = false;
  let bkdPressed = false;
  let lftPressed = false;
  let rgtPressed = false;
  let shiftPressed = false;

  let touchX = 0;
  let touchY = 0;
  let touchLookPointerId: number | null = null;
  let lastTouchX = 0;
  let lastTouchY = 0;
  let lastInputMs = Number.NEGATIVE_INFINITY;

  function applyPose(): void {
    camera.position.set(foot[0], foot[1] + eyeHeight, foot[2]);
    const targetX = camera.position.x + Math.sin(yaw) * Math.cos(pitch);
    const targetY = camera.position.y + Math.sin(pitch);
    const targetZ = camera.position.z - Math.cos(yaw) * Math.cos(pitch);
    camera.lookAt(targetX, targetY, targetZ);
  }

  function onClick(): void {
    if (isEnabled && !isTouch && document.pointerLockElement !== element) {
      void element.requestPointerLock();
    }
  }

  function onMouseMove(event: MouseEvent): void {
    if (!isEnabled || document.pointerLockElement !== element) {
      return;
    }
    yaw += event.movementX * ROTATE_PER_PIXEL;
    pitch -= event.movementY * ROTATE_PER_PIXEL;
    pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
    lastInputMs = now();
    applyPose();
    onChange();
  }

  function onKeyDown(event: KeyboardEvent): void {
    const source = event.target;
    const interactiveSource =
      source instanceof HTMLElement &&
      source !== element &&
      source.closest('a, button, input, select, textarea, [contenteditable="true"]') !== null;
    if (!isEnabled || interactiveSource) {
      return;
    }
    switch (event.code) {
      case 'KeyW':
      case 'ArrowUp':
        fwdPressed = true;
        break;
      case 'KeyS':
      case 'ArrowDown':
        bkdPressed = true;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        lftPressed = true;
        break;
      case 'KeyD':
      case 'ArrowRight':
        rgtPressed = true;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        shiftPressed = true;
        break;
      default:
        return;
    }
    lastInputMs = now();
    onChange();
  }

  function onKeyUp(event: KeyboardEvent): void {
    switch (event.code) {
      case 'KeyW':
      case 'ArrowUp':
        fwdPressed = false;
        break;
      case 'KeyS':
      case 'ArrowDown':
        bkdPressed = false;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        lftPressed = false;
        break;
      case 'KeyD':
      case 'ArrowRight':
        rgtPressed = false;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        shiftPressed = false;
        break;
      default:
        break;
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (!isEnabled || !isTouch || touchLookPointerId !== null) {
      return;
    }
    // Only drags on the right half of the viewport control camera look.
    const rect = element.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    if (event.clientX >= midX) {
      touchLookPointerId = event.pointerId;
      lastTouchX = event.clientX;
      lastTouchY = event.clientY;
      lastInputMs = now();
      capturePointer(element, event.pointerId);
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!isEnabled || event.pointerId !== touchLookPointerId) {
      return;
    }
    const dx = event.clientX - lastTouchX;
    const dy = event.clientY - lastTouchY;
    lastTouchX = event.clientX;
    lastTouchY = event.clientY;
    yaw += dx * ROTATE_PER_PIXEL;
    pitch -= dy * ROTATE_PER_PIXEL;
    pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
    lastInputMs = now();
    applyPose();
    onChange();
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== touchLookPointerId) {
      return;
    }
    touchLookPointerId = null;
    releasePointer(element, event.pointerId);
  }

  function onPointerLockChange(): void {
    // If pointer lock was released (e.g. Esc pressed), clear keyboard repeat states.
    if (document.pointerLockElement !== element) {
      fwdPressed = false;
      bkdPressed = false;
      lftPressed = false;
      rgtPressed = false;
      shiftPressed = false;
    }
  }

  function bind(): void {
    element.addEventListener('click', onClick);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('pointerlockchange', onPointerLockChange);

    if (isTouch) {
      element.addEventListener('pointerdown', onPointerDown);
      element.addEventListener('pointermove', onPointerMove);
      element.addEventListener('pointerup', onPointerUp);
      element.addEventListener('pointercancel', onPointerUp);
    }
  }

  function unbind(): void {
    element.removeEventListener('click', onClick);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('pointerlockchange', onPointerLockChange);

    if (isTouch) {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
    }

    fwdPressed = false;
    bkdPressed = false;
    lftPressed = false;
    rgtPressed = false;
    shiftPressed = false;
    touchX = 0;
    touchY = 0;
    touchLookPointerId = null;
  }

  return {
    enable(): void {
      if (isEnabled) {
        return;
      }
      isEnabled = true;
      bind();
      applyPose();
    },

    disable(): void {
      if (!isEnabled) {
        return;
      }
      isEnabled = false;
      if (typeof document !== 'undefined' && document.pointerLockElement === element) {
        document.exitPointerLock();
      }
      unbind();
    },

    get enabled(): boolean {
      return isEnabled;
    },

    update(dtMs: number): boolean {
      if (!isEnabled) {
        return false;
      }
      const step = Math.min(Math.max(dtMs, 0), MAX_STEP_MS);
      const dtSec = step / 1000;

      let fwd = (fwdPressed ? 1 : 0) - (bkdPressed ? 1 : 0) + touchY;
      let strafe = (rgtPressed ? 1 : 0) - (lftPressed ? 1 : 0) + touchX;

      const mag = Math.hypot(fwd, strafe);
      if (mag > 1) {
        fwd /= mag;
        strafe /= mag;
      }

      if (fwd === 0 && strafe === 0) {
        return now() - lastInputMs < STILL_MOVE_MS;
      }

      const speed = (shiftPressed ? 2 : 1) * walkSpeed;
      const dirX = Math.sin(yaw);
      const dirZ = -Math.cos(yaw);
      const rightX = Math.cos(yaw);
      const rightZ = Math.sin(yaw);

      const vx = (dirX * fwd + rightX * strafe) * speed;
      const vz = (dirZ * fwd + rightZ * strafe) * speed;

      const dx = vx * dtSec;
      const dz = vz * dtSec;

      proposedFoot.set(foot[0] + dx, 0, foot[2] + dz);
      const resolved = resolver !== null ? resolver.resolve(proposedFoot) : proposedFoot;

      foot[0] = resolved.x;
      foot[1] = 0;
      foot[2] = resolved.z;

      lastInputMs = now();
      applyPose();
      onChange();
      return true;
    },

    setPose(newFoot: [number, number, number], newYaw: number, newPitch: number): void {
      foot[0] = newFoot[0];
      foot[1] = newFoot[1];
      foot[2] = newFoot[2];
      yaw = newYaw;
      pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, newPitch));
      if (isEnabled) {
        applyPose();
      }
      onChange();
    },

    get foot(): [number, number, number] {
      return [foot[0], foot[1], foot[2]];
    },

    get yaw(): number {
      return yaw;
    },

    get pitch(): number {
      return pitch;
    },

    get moving(): boolean {
      return (
        fwdPressed ||
        bkdPressed ||
        lftPressed ||
        rgtPressed ||
        touchX !== 0 ||
        touchY !== 0 ||
        touchLookPointerId !== null ||
        now() - lastInputMs < STILL_MOVE_MS
      );
    },

    setJoystickVector(x: number, y: number): void {
      touchX = x;
      touchY = y;
      if (x !== 0 || y !== 0) {
        lastInputMs = now();
        onChange();
      }
    },

    dispose(): void {
      this.disable();
    },
  };
}
