// Camera wiring: the one place the camera code touches the page.
// Integrates the orbit inspection camera, turntable, walkthrough camera with capsule collision,
// blended mode transitions, catalogue view presets, and the idle attract tour.

import { Vector3 } from 'three/webgpu';
import type { PerspectiveCamera } from 'three/webgpu';

import type { CatalogView } from '../catalog/catalog';
import { afterFirstFrame } from '../proof/marks';
import { onReducedMotionChange, prefersReducedMotion } from '../ui/announce';
import { ATTRACT_IDLE_MS, ATTRACT_MOVE_MS, createAttract } from './attract';
import type { AttractHandle } from './attract';
import { BLEND_MS, blendPoseInto, copyPose } from './blend';
import type { Pose } from './blend';
import { createOrbit } from './orbit';
import type { OrbitHandle, OrbitLimits } from './orbit';
import { createPresets } from './presets';
import type { PresetsHandle } from './presets';
import { createTurntable } from './turntable';
import type { Turntable } from './turntable';
import type { CameraMode, WalkLoader, WalkLoadState, WalkthroughHandle } from './contracts';
import { WALK_EYE_HEIGHT } from './walk-settings';
import { createWalkLoad } from './walk-load';
import type { WalkLoadOptions } from './walk-load';

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
  createWalkLoader?: (options: WalkLoadOptions) => WalkLoader;
  onDispose?: () => void;
}

export interface CameraMount {
  orbit: OrbitHandle;
  turntable: Turntable;
  readonly walk: WalkthroughHandle | undefined;
  readonly mode: CameraMode;
  /** Resolves on completion, supersession or disposal; rejects an active load failure. */
  setMode(mode: CameraMode): Promise<void>;
  onModeChange(listener: (mode: CameraMode) => void): () => void;
  presets: PresetsHandle;
  attract: AttractHandle;
  /** Call from the loop's render callback with the frame's dt. */
  update(dtMs: number): void;
  /**
   * True while the orbit glides, the turntable runs, a walk step, a blend or a preset glide is in
   * flight, or the attract tour runs.
   */
  readonly moving: boolean;
  readonly pendingMode: CameraMode | null;
  readonly walkLoadState: WalkLoadState;
  onWalkStateChange(listener: () => void): () => void;
  readonly walkReady: boolean;
  onWalkReady(listener: () => void): () => void;
  dispose(): void;
}

// Measured 2026-10-17: plinth top 0.15 m; tallest look head about 2.09 m.
const MIN_TARGET_HEIGHT = 0.15;
const MAX_TARGET_HEIGHT = 2.1;

/** Inside the rotunda, above the floor, off the zenith: the room is about 16 m across. */
const LIMITS: OrbitLimits = {
  minDistance: 1.2,
  maxDistance: 7,
  minPolar: 0.15,
  maxPolar: Math.PI / 2 - 0.05,
  minTargetHeight: MIN_TARGET_HEIGHT,
  maxTargetHeight: MAX_TARGET_HEIGHT,
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
      readonly walk: WalkthroughHandle | undefined;
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
  let attractWake: ReturnType<typeof setTimeout> | null = null;

  function clearAttractWake(): void {
    if (attractWake === null) return;
    clearTimeout(attractWake);
    attractWake = null;
  }

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
    clearAttractWake();
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

  let disposed = false;
  const walkLoader = (options.createWalkLoader ?? createWalkLoad)({
    camera,
    canvas,
    collisionUrl,
    isTouch,
    now: clock,
    onChange: () => {
      if (currentMode === 'walk' && walkLoader.session?.walk.moving) {
        hold();
      } else {
        loop.invalidate();
      }
    },
  });

  // Touch startup reserves bandwidth for the opening scene. Explicit Walk still loads immediately.
  const preloadLifetime = new AbortController();
  let preload: ReturnType<typeof setTimeout> | null = null;
  function queuePreload(): void {
    preload = setTimeout(() => {
      preload = null;
      // A failed preload published the walk error state (Retry Walk); this stops the unhandled rejection.
      void walkLoader.ensureReady().catch(() => {});
    }, 0);
  }
  function cancelPreload(): void {
    preloadLifetime.abort();
    if (preload !== null) { clearTimeout(preload); preload = null; }
  }
  if (isTouch) afterFirstFrame(queuePreload, preloadLifetime.signal);
  else queuePreload();

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
    readStart: (destination) => {
      // The target getter copies once per idle start; running tour frames read no orbit arrays.
      const target = orbit.target;
      destination.pose.position[0] = camera.position.x;
      destination.pose.position[1] = camera.position.y;
      destination.pose.position[2] = camera.position.z;
      destination.pose.target[0] = target[0];
      destination.pose.target[1] = target[1];
      destination.pose.target[2] = target[2];
      destination.fov = orbit.fov;
    },
    idleMs: attractIdleMs,
    moveMs: ATTRACT_MOVE_MS,
    enabled: attractEnabled,
    reducedMotion: prefersReducedMotion(),
    now: clock,
    onWaitChange: () => {
      clearAttractWake();
      scheduleAttractWake();
    },
  });

  // The pose and fov the tour last placed: repeated ticks at the same time need no placement.
  // The cache describes camera state while the tour is driving, so input and ticks without tour
  // ownership void it; otherwise a restart would trust a placement the visitor has since overwritten.
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

  interface BlendFields {
    fromPose: Pose;
    toPose: Pose;
    durationMs: number;
    elapsedMs: number;
    resolve: () => void;
  }
  /** Lands in orbit mode: the orbit control takes over the final pose. */
  interface OrbitBlend extends BlendFields {
    targetMode: 'orbit';
  }
  /** Lands in walk mode: the walk controller takes the pose the blend carried. */
  interface WalkBlend extends BlendFields {
    targetMode: 'walk';
    targetFoot: [number, number, number];
    targetYaw: number;
    targetPitch: number;
  }
  type ActiveBlend = OrbitBlend | WalkBlend;
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
    const changed = currentMode !== mode;
    currentMode = mode;
    canvas.dataset['camera'] = mode;
    const walkSession = walkLoader.session;
    if (mode === 'walk') {
      // Walk handovers come only from blends begun at walkLoader state 'ready', which the
      // loader publishes together with the session and revokes only on its dispose.
      orbit.setEnabled(false);
      walkSession!.walk.enable();
      walkSession!.setJoystickVisible(true);
    } else {
      walkSession?.walk.disable();
      orbit.setEnabled(true);
      walkSession?.setJoystickVisible(false);
    }
    if (changed) for (const listener of modeListeners) listener(mode);
  }

  interface ModeRequest {
    mode: CameraMode;
    promise: Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
  }
  let request: ModeRequest | null = null;
  const stateListeners = new Set<() => void>();
  function notifyState(): void {
    for (const listener of stateListeners) listener();
  }
  const unlistenLoad = walkLoader.onStateChange(notifyState);

  function finishRequest(current: ModeRequest, error?: unknown, failed = false): void {
    if (request !== current) return;
    request = null;
    attract.noteInput();
    notifyState();
    if (failed) current.reject(error);
    else current.resolve();
  }

  function beginBlend(current: ModeRequest, interrupted: boolean): void {
    const mode = current.mode;
    const walkSession = walkLoader.session;
    // Capture only after readiness, including any Orbit input during the load.
    if (!interrupted) {
      if (currentMode === 'orbit') {
        storedOrbitPose = { position: [...orbit.position], target: [...orbit.target] };
      } else if (walkSession !== null) {
        storedWalkFoot = walkSession.walk.foot;
        storedWalkYaw = walkSession.walk.yaw;
        storedWalkPitch = walkSession.walk.pitch;
      }
    }
    const direction = camera.getWorldDirection(new Vector3());
    const fromPose: Pose = {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [camera.position.x + direction.x, camera.position.y + direction.y,
        camera.position.z + direction.z],
    };
    const toPose = mode === 'walk'
      ? getWalkCameraPose(storedWalkFoot, storedWalkYaw, storedWalkPitch) : storedOrbitPose;
    orbit.setEnabled(false);
    walkSession?.walk.disable();
    walkSession?.setJoystickVisible(false);
    // setMode begins a walk blend only under walkLoader state 'ready', which implies the session.
    if (mode === 'walk') walkSession!.walk.setPose(storedWalkFoot, storedWalkYaw, storedWalkPitch);
    const duration = prefersReducedMotion() ? 0 : BLEND_MS;
    if (duration === 0) {
      camera.position.set(...toPose.position);
      camera.lookAt(...toPose.target);
      if (mode === 'orbit') orbit.moveTo(toPose.position, toPose.target);
      applyModeHandover(mode);
      finishRequest(current);
      loop.invalidate();
      release();
      return;
    }
    hold();
    activeBlend = mode === 'walk'
      ? {
        fromPose, toPose, durationMs: duration, elapsedMs: 0, targetMode: 'walk',
        targetFoot: storedWalkFoot, targetYaw: storedWalkYaw, targetPitch: storedWalkPitch,
        resolve: () => finishRequest(current),
      }
      : {
        fromPose, toPose, durationMs: duration, elapsedMs: 0, targetMode: 'orbit',
        resolve: () => finishRequest(current),
      };
    loop.invalidate();
  }

  function setMode(mode: CameraMode): Promise<void> {
    if (disposed) return Promise.resolve();
    cancelPreload();
    if (request?.mode === mode) return request.promise;
    const interrupted = activeBlend !== null;
    activeBlend = null;
    const previous = request;
    request = null;
    previous?.resolve();
    // Cancellation precedes even the same-mode return while Orbit owns the camera.
    if (mode === 'orbit') {
      walkLoader.cancel();
    }
    attract.noteInput();
    attractPoseApplied = false;
    if (mode === currentMode && !interrupted) {
      notifyState();
      return Promise.resolve();
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const current: ModeRequest = { mode, promise, resolve, reject };
    request = current;
    clearAttractWake();
    notifyState();
    if (mode === 'orbit' || walkLoader.state === 'ready') beginBlend(current, interrupted);
    else {
      void walkLoader.ensureReady().then((ready) => {
        if (disposed || request !== current || ready === null) return;
        beginBlend(current, interrupted);
      }).catch((error: unknown) => {
        if (disposed || request !== current) return;
        finishRequest(current, error, true);
      });
    }
    return promise;
  }

  const exposed =
    import.meta.env.DEV || new URLSearchParams(window.location.search).get('e2e') === '1';
  if (exposed) {
    window.archvizCamera = {
      orbit,
      turntable,
      get walk(): WalkthroughHandle | undefined {
        return walkLoader.session?.walk;
      },
      get mode(): CameraMode {
        return currentMode;
      },
      setMode,
      presets,
      attract,
    };
  }

  function isMoving(): boolean {
    return (
      orbit.moving ||
      turntable.running ||
      (walkLoader.session?.walk.moving ?? false) ||
      activeBlend !== null ||
      attract.running
    );
  }

  // A sleeping render loop cannot tick the idle clock. Owe one frame at its deadline;
  // update() hands continuous frames to the tour once it starts. Other camera motion owns
  // its own frames, so only a still orbit camera needs this timeout.
  function scheduleAttractWake(): void {
    const remaining = attract.msUntilStart();
    if (
      disposed || currentMode !== 'orbit' || request !== null || activeBlend !== null ||
      turntable.running || orbit.moving || remaining === null
    ) {
      clearAttractWake();
      return;
    }
    if (attractWake !== null) return;
    attractWake = setTimeout(() => {
      attractWake = null;
      loop.invalidate();
    }, remaining);
  }

  const unlistenMotion = onReducedMotionChange((reduced) => {
    attract.setReducedMotion(reduced);
    attractPoseApplied = false;
    canvas.dataset['attract'] = '0';
    if (!isMoving()) release();
    loop.invalidate();
  });

  scheduleAttractWake();

  return {
    orbit,
    turntable,
    get walk(): WalkthroughHandle | undefined {
      return walkLoader.session?.walk;
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

    get pendingMode() { return request?.mode ?? null; },
    get walkLoadState() { return walkLoader.state; },
    onWalkStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    get walkReady(): boolean {
      return walkLoader.state === 'ready';
    },

    onWalkReady(listener: () => void): () => void {
      return walkLoader.onStateChange(() => { if (walkLoader.state === 'ready') listener(); });
    },

    update(dtMs: number): void {
      if (disposed) return;
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
              // A walk blend exists only under that readiness gate; the loader keeps its
              // session until dispose, and dispose stops update() before this line.
              walkLoader.session!.walk.setPose(blend.targetFoot, blend.targetYaw, blend.targetPitch);
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
      const walkMoving = currentMode === 'walk' ? (walkLoader.session?.walk.update(step) ?? false) : false;
      const yaw = turntable.update(step);

      if (turntable.running && yaw !== appliedYaw) {
        writeYaw(yaw);
      }

      // Attract loop ticking (orbit mode only, turntable not running).
      if (currentMode === 'orbit' && request === null && !turntable.running && !orbit.moving) {
        const tickResult = attract.tick();
        if (tickResult !== null) {
          canvas.dataset['attract'] = '1';
          // Apply only what moved since the last placement and keep the tour's frames running.
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
      scheduleAttractWake();
    },

    get moving(): boolean {
      return isMoving();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearAttractWake();
      unlistenMotion();
      cancelPreload();
      request?.resolve();
      request = null;
      unlistenLoad();
      stateListeners.clear();
      modeListeners.clear();
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
      walkLoader.dispose();
      options.onDispose?.();

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
