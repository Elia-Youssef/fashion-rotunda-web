// Camera wiring: the one place the camera code touches the page.
// Integrates the orbit inspection camera, turntable, walkthrough camera with capsule collision,
// blended mode transitions, catalogue view presets, and the idle attract tour.

import type { PerspectiveCamera } from 'three/webgpu';

import type { CatalogView } from '../catalog/catalog';
import { prefersReducedMotion } from '../ui/announce';
import { ATTRACT_HOLD_MS, ATTRACT_IDLE_MS, ATTRACT_MOVE_MS, createAttract } from './attract';
import type { AttractHandle } from './attract';
import { BLEND_MS, blendPoseInto, copyPose } from './blend';
import type { Pose } from './blend';
import { createOrbit } from './orbit';
import type { OrbitHandle, OrbitLimits } from './orbit';
import { createPresets } from './presets';
import type { PresetsHandle } from './presets';
import { createTurntable } from './turntable';
import type { Turntable } from './turntable';
import type { CameraMode, WalkthroughHandle } from './contracts';
import { WALK_EYE_HEIGHT } from './walk-settings';
import { createWalkSession } from './walk-session';

export type { CameraMode } from './contracts';

export interface CameraMountOptions {
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
  showroom: { setLookYaw(radians: number): void; readonly lookYaw: number };
  loop: { invalidate(): void; setAnimating(on: boolean): void };
  proofView: { position: [number, number, number]; target: [number, number, number] };
  views: Record<string, CatalogView>; // catalog.views; the proof view is one of them
  isTouch: boolean;
  collisionUrl: string; // contentUrl(base, 'collision.glb')
  search: string; // location.search: ?attract=0|1 and ?attractIdle=<ms>
  now?: () => number;
}

export interface CameraMount {
  orbit: OrbitHandle;
  turntable: Turntable;
  walk: WalkthroughHandle;
  readonly mode: CameraMode;
  /** Resolves once the blend has landed and the target mode has control. */
  setMode(mode: CameraMode): Promise<void>;
  onModeChange(listener: (mode: CameraMode) => void): () => void;
  presets: PresetsHandle;
  attract: AttractHandle;
  /** Call from the loop's render callback with the frame's dt. */
  update(dtMs: number): void;
  /**
   * True while the orbit glides, the turntable runs, a walk step or a blend or a preset glide
   * is in flight.
   */
  readonly moving: boolean;
  readonly walkReady: boolean;
  onWalkReady(listener: () => void): () => void;
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
const MAX_STEP_MS = 100;
const YAW_DECIMALS = 3;
const YAW_HALF_STEP = 0.5 * 10 ** -YAW_DECIMALS;
// Cover rounding in both the parsed decimal centre and the subtraction from the live yaw.
const YAW_ROUNDING_ERROR_SCALE = 2;

/** True when two poses hold the same six numbers. */
function samePose(a: Pose, b: Pose): boolean {
  return (
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2] &&
    a.target[0] === b.target[0] &&
    a.target[1] === b.target[1] &&
    a.target[2] === b.target[2]
  );
}

export function attractIdleMsFromSearch(search: string): number {
  const value = new URLSearchParams(search).get('attractIdle');
  if (value === null) {
    return ATTRACT_IDLE_MS;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(100, parsed) : ATTRACT_IDLE_MS;
}

declare global {
  interface Window {
    archvizCamera?: {
      orbit: OrbitHandle;
      turntable: Turntable;
      walk?: WalkthroughHandle;
      readonly mode: CameraMode;
      setMode: (mode: CameraMode) => Promise<void>;
      presets: PresetsHandle;
      attract: AttractHandle;
    };
  }
}

export function mountCamera(options: CameraMountOptions): CameraMount {
  const {
    camera,
    canvas,
    showroom,
    loop,
    proofView,
    views = { proof: { position: proofView.position, target: proofView.target, fov: 40 } },
    isTouch = false,
    collisionUrl,
    search = '',
  } = options;

  const clock = options.now ?? ((): number => performance.now());

  const hadTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';
  const hadTabIndex = canvas.getAttribute('tabindex');
  canvas.tabIndex = 0;

  let holding = false;
  let appliedYaw = showroom.lookYaw;
  let publishedYaw = '';
  let publishedYawValue = Number.NaN;
  let currentMode: CameraMode = 'orbit';
  canvas.dataset['camera'] = 'orbit';
  canvas.dataset['attract'] = '0';

  function writeYaw(yaw: number): void {
    appliedYaw = yaw;
    showroom.setLookYaw(yaw);
    // Stay strictly inside the last decimal cell. Near its edges, let toFixed decide:
    // multiplication followed by Math.round disagrees with it at binary rounding ties.
    const roundingMargin = YAW_ROUNDING_ERROR_SCALE * Number.EPSILON *
      Math.max(1, Math.abs(yaw), Math.abs(publishedYawValue));
    if (
      (yaw < 0) === publishedYaw.startsWith('-') &&
      Math.abs(yaw - publishedYawValue) < YAW_HALF_STEP - roundingMargin
    ) {
      return;
    }
    const next = yaw.toFixed(YAW_DECIMALS);
    if (next !== publishedYaw) {
      canvas.dataset['yaw'] = next;
      publishedYaw = next;
      publishedYawValue = Number(next);
    }
  }

  function hold(): void {
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

  const orbit = createOrbit({
    camera,
    element: canvas,
    target: proofView.target,
    limits: LIMITS,
    damping: DAMPING,
    now: clock,
    onChange: () => {
      if (orbit.moving) {
        hold();
      } else {
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
        writeYaw(turntable.yaw);
        loop.invalidate();
      }
    },
  });

  orbit.setPose(proofView.position, proofView.target);

  // Stored poses for seamless blending.
  let storedOrbitPose: Pose = {
    position: [...proofView.position],
    target: [...proofView.target],
  };
  let storedWalkFoot: [number, number, number] = [0, 0, 5.5];
  let storedWalkYaw = 0;
  let storedWalkPitch = 0;

  const walkSession = createWalkSession({
    camera,
    canvas,
    collisionUrl,
    isTouch,
    now: clock,
    onChange: () => {
      if (walkSession.walk.moving) {
        hold();
      } else {
        loop.invalidate();
      }
    },
  });

  // Presets
  const presets = createPresets(views, orbit, prefersReducedMotion);

  // Attract Loop configuration from search params.
  const searchParams = new URLSearchParams(search);
  let attractEnabled = !isTouch;
  if (searchParams.get('attract') === '1') {
    attractEnabled = true;
  } else if (searchParams.get('attract') === '0') {
    attractEnabled = false;
  }
  const attractIdleMs = attractIdleMsFromSearch(search);

  const attract = createAttract({
    views: presets.list,
    idleMs: attractIdleMs,
    holdMs: ATTRACT_HOLD_MS,
    moveMs: ATTRACT_MOVE_MS,
    enabled: attractEnabled,
    reducedMotion: prefersReducedMotion(),
    now: clock,
  });

  // The pose and fov the tour last placed: a hold re-reports the same reading on every tick,
  // and re-placing it would run the orbit apply path for an unchanged camera. The cache only
  // describes camera state while the tour is driving, so it is voided on input and on every
  // tick that finds the tour not driving; otherwise a restart on the same view would trust a
  // placement the visitor has since overwritten.
  const lastAttractPose: Pose = { position: [0, 0, 0], target: [0, 0, 0] };
  let lastAttractFov = 0;
  let attractPoseApplied = false;

  const onWindowInput = (): void => {
    attract.noteInput();
    attractPoseApplied = false;
  };
  window.addEventListener('pointerdown', onWindowInput, { passive: true });
  window.addEventListener('pointermove', onWindowInput, { passive: true });
  window.addEventListener('keydown', onWindowInput, { passive: true });
  window.addEventListener('wheel', onWindowInput, { passive: true });
  window.addEventListener('touchstart', onWindowInput, { passive: true });

  // Mode switching & blending
  const modeListeners = new Set<(mode: CameraMode) => void>();

  interface ActiveBlend {
    fromPose: Pose;
    toPose: Pose;
    durationMs: number;
    elapsedMs: number;
    targetMode: CameraMode;
    targetFoot?: [number, number, number];
    targetYaw?: number;
    targetPitch?: number;
    resolve: () => void;
  }
  let activeBlend: ActiveBlend | null = null;
  // The blend writes its interpolation here once per frame instead of allocating a fresh pose.
  const blendDestination: Pose = { position: [0, 0, 0], target: [0, 0, 0] };

  function getWalkCameraPose(
    footPos: [number, number, number],
    lookYaw: number,
    lookPitch: number,
  ): Pose {
    const eyeY = footPos[1] + WALK_EYE_HEIGHT;
    const targetX = footPos[0] + Math.sin(lookYaw) * Math.cos(lookPitch);
    const targetY = eyeY + Math.sin(lookPitch);
    const targetZ = footPos[2] - Math.cos(lookYaw) * Math.cos(lookPitch);
    return {
      position: [footPos[0], eyeY, footPos[2]],
      target: [targetX, targetY, targetZ],
    };
  }

  function applyModeHandover(mode: CameraMode): void {
    currentMode = mode;
    canvas.dataset['camera'] = mode;
    if (mode === 'walk') {
      orbit.setEnabled(false);
      walkSession.walk.enable();
      walkSession.setJoystickVisible(true);
    } else {
      walkSession.walk.disable();
      orbit.setEnabled(true);
      walkSession.setJoystickVisible(false);
    }
    for (const listener of modeListeners) {
      listener(mode);
    }
  }

  function setMode(mode: CameraMode): Promise<void> {
    if (mode === currentMode && activeBlend === null) {
      return Promise.resolve();
    }

    if (activeBlend !== null) {
      const finish = activeBlend.resolve;
      activeBlend = null;
      finish();
    }

    // Capture leaving mode pose.
    if (currentMode === 'orbit') {
      storedOrbitPose = {
        position: [...orbit.position],
        target: [...orbit.target],
      };
    } else {
      storedWalkFoot = walkSession.walk.foot;
      storedWalkYaw = walkSession.walk.yaw;
      storedWalkPitch = walkSession.walk.pitch;
    }

    const fromPose: Pose = {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target:
        currentMode === 'orbit'
          ? storedOrbitPose.target
          : getWalkCameraPose(storedWalkFoot, storedWalkYaw, storedWalkPitch).target,
    };

    let toPose: Pose;
    let targetFoot: [number, number, number] | undefined;
    let targetYaw: number | undefined;
    let targetPitch: number | undefined;

    if (mode === 'walk') {
      targetFoot = storedWalkFoot;
      targetYaw = storedWalkYaw;
      targetPitch = storedWalkPitch;
      toPose = getWalkCameraPose(targetFoot, targetYaw, targetPitch);
    } else {
      toPose = storedOrbitPose;
    }

    const duration = prefersReducedMotion() ? 0 : BLEND_MS;

    if (duration <= 0) {
      camera.position.set(...toPose.position);
      camera.lookAt(...toPose.target);
      if (mode === 'walk') {
        walkSession.walk.setPose(targetFoot!, targetYaw!, targetPitch!);
      } else {
        orbit.moveTo(toPose.position, toPose.target);
      }
      applyModeHandover(mode);
      loop.invalidate();
      return Promise.resolve();
    }

    // Disable controls during blend.
    orbit.setEnabled(false);
    walkSession.walk.disable();
    walkSession.setJoystickVisible(false);
    hold();

    return new Promise<void>((resolve) => {
      activeBlend = {
        fromPose,
        toPose,
        durationMs: duration,
        elapsedMs: 0,
        targetMode: mode,
        ...(targetFoot !== undefined ? { targetFoot } : {}),
        ...(targetYaw !== undefined ? { targetYaw } : {}),
        ...(targetPitch !== undefined ? { targetPitch } : {}),
        resolve,
      };
      loop.invalidate();
    });
  }

  const exposed =
    import.meta.env.DEV || new URLSearchParams(window.location.search).get('e2e') === '1';
  if (exposed) {
    window.archvizCamera = {
      orbit,
      turntable,
      get walk(): WalkthroughHandle {
        return walkSession.walk;
      },
      get mode(): CameraMode {
        return currentMode;
      },
      setMode,
      presets,
      attract,
    };
  }

  return {
    orbit,
    turntable,
    get walk(): WalkthroughHandle {
      return walkSession.walk;
    },
    get mode(): CameraMode {
      return currentMode;
    },
    setMode,
    onModeChange(listener: (mode: CameraMode) => void): () => void {
      modeListeners.add(listener);
      return () => modeListeners.delete(listener);
    },
    presets,
    attract,

    get walkReady(): boolean {
      return walkSession.ready;
    },

    onWalkReady(listener: () => void): () => void {
      return walkSession.onReady(listener);
    },

    update(dtMs: number): void {
      const step = Math.min(Math.max(dtMs, 0), MAX_STEP_MS);

      // Handle active blend transition.
      if (activeBlend !== null) {
        if (step > 0) {
          activeBlend.elapsedMs += step;
          const t = Math.min(1, activeBlend.elapsedMs / activeBlend.durationMs);
          const blended = blendPoseInto(activeBlend.fromPose, activeBlend.toPose, t, blendDestination);
          camera.position.set(...blended.position);
          camera.lookAt(...blended.target);
          loop.invalidate();

          if (t >= 1) {
            const blend = activeBlend;
            activeBlend = null;
            if (blend.targetMode === 'walk') {
              walkSession.walk.setPose(blend.targetFoot!, blend.targetYaw!, blend.targetPitch!);
            } else {
              orbit.moveTo(blend.toPose.position, blend.toPose.target);
            }
            applyModeHandover(blend.targetMode);
            blend.resolve();
            release();
          }
        }
        return;
      }

      // Normal mode updates.
      const orbitMoving = orbit.update(step);
      const walkMoving = currentMode === 'walk' ? walkSession.walk.update(step) : false;
      const yaw = turntable.update(step);

      if (turntable.running && yaw !== appliedYaw) {
        writeYaw(yaw);
      }

      // Attract loop ticking (orbit mode only, turntable not running).
      if (currentMode === 'orbit' && !turntable.running && !orbit.moving) {
        const tickResult = attract.tick();
        if (tickResult !== null) {
          canvas.dataset['attract'] = '1';
          // Apply only what moved since the last placement, and keep holding either way so the
          // hold still ends on time and any other animation keeps its frames.
          const pose = tickResult.pose;
          if (
            !attractPoseApplied ||
            tickResult.fov !== lastAttractFov ||
            !samePose(pose, lastAttractPose)
          ) {
            copyPose(pose, lastAttractPose);
            lastAttractFov = tickResult.fov;
            attractPoseApplied = true;
            orbit.placeAt(pose.position, pose.target, tickResult.fov);
          }
          hold();
        } else {
          canvas.dataset['attract'] = '0';
          attractPoseApplied = false;
        }
      } else {
        canvas.dataset['attract'] = '0';
        attractPoseApplied = false;
      }

      if (!orbitMoving && !walkMoving && !turntable.running && !attract.running) {
        release();
      }
    },

    get moving(): boolean {
      return (
        orbit.moving ||
        turntable.running ||
        walkSession.walk.moving ||
        activeBlend !== null ||
        attract.running
      );
    },

    dispose(): void {
      release();
      window.removeEventListener('pointerdown', onWindowInput);
      window.removeEventListener('pointermove', onWindowInput);
      window.removeEventListener('keydown', onWindowInput);
      window.removeEventListener('wheel', onWindowInput);
      window.removeEventListener('touchstart', onWindowInput);

      if (activeBlend !== null) {
        activeBlend.resolve();
        activeBlend = null;
      }

      orbit.dispose();
      turntable.stop();
      walkSession.dispose();

      canvas.style.touchAction = hadTouchAction;
      if (hadTabIndex === null) {
        canvas.removeAttribute('tabindex');
      } else {
        canvas.setAttribute('tabindex', hadTabIndex);
      }
      delete canvas.dataset['yaw'];
      delete canvas.dataset['camera'];
      delete canvas.dataset['attract'];
      if (window.archvizCamera?.orbit === orbit) {
        delete window.archvizCamera;
      }
    },
  };
}
