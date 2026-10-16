import { BufferGeometry } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { WalkSession, WalkSessionOptions, WalkthroughHandle } from './contracts';
import { mountJoystick } from './joystick';
import type { JoystickHandle } from './joystick';
import { WALK_EYE_HEIGHT, WALK_RADIUS, WALK_SPEED } from './walk-settings';
import { createWalkthrough } from './walkthrough';

interface JoystickLayer {
  root: HTMLElement;
  dispose(): void;
}

/** Keeps the touch control inside the canvas rect when the shell flattens on tablet. */
function mountJoystickLayer(canvas: HTMLCanvasElement): JoystickLayer {
  const root = document.createElement('div');
  root.className = 'archviz-joystick-layer';
  document.body.appendChild(root);
  let observer: ResizeObserver | null = null;

  function place(): void {
    const rect = canvas.getBoundingClientRect();
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    root.style.width = `${rect.width}px`;
    root.style.height = `${rect.height}px`;
  }

  function dispose(): void {
    window.removeEventListener('resize', place);
    observer?.disconnect();
    root.remove();
  }

  try {
    place();
    window.addEventListener('resize', place, { passive: true });
    observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(canvas);
    return { root, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Owns temporary and collision-ready controllers, parsed geometry and touch controls. */
export function createWalkSession(options: WalkSessionOptions): WalkSession {
  const { camera, canvas, isTouch, onChange, now } = options;
  // Assigned by the constructor below before the session is returned (a constructor that throws
  // returns nothing), and from then on only replaced by setupCollision with fully constructed
  // controllers: never null on a session that exists.
  let currentWalk: WalkthroughHandle;
  let ownedGeometry: BufferGeometry | null = new BufferGeometry();
  let joystick: JoystickHandle | null = null;
  let joystickLayer: JoystickLayer | null = null;
  let disposed = false;
  let ready = false;
  let cancelParse: (() => void) | null = null;
  const readyListeners = new Set<() => void>();

  function createController(geometry: BufferGeometry): WalkthroughHandle {
    return createWalkthrough({
      camera,
      element: canvas,
      collision: geometry,
      eyeHeight: WALK_EYE_HEIGHT,
      radius: WALK_RADIUS,
      walkSpeed: WALK_SPEED,
      isTouch,
      now,
      onChange,
    });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    cancelParse?.();
    cancelParse = null;
    currentWalk.dispose();
    joystick?.dispose();
    joystickLayer?.dispose();
    ownedGeometry?.dispose();
    readyListeners.clear();
  }

  function setupCollision(geometry: BufferGeometry): void {
    const previous = currentWalk;
    const previousFoot = previous.foot;
    const previousYaw = previous.yaw;
    const previousPitch = previous.pitch;
    const wasEnabled = previous.enabled;
    let next: WalkthroughHandle;
    try {
      next = createController(geometry);
    } catch (error) {
      geometry.dispose();
      throw error;
    }

    // Publish only a fully constructed replacement; a failed BVH leaves the old owner intact.
    previous.dispose();
    ownedGeometry?.dispose();
    ownedGeometry = geometry;
    currentWalk = next;
    next.setPose(previousFoot, previousYaw, previousPitch);
    if (wasEnabled) next.enable();
    ready = true;
    for (const listener of readyListeners) listener();
  }

  // Keep the transitional controller private until validated collision replaces it. Its
  // construction is the first allocation: when it throws, the placeholder geometry is the only
  // resource to roll back. Anything mounted after it fails through the shared dispose.
  try {
    currentWalk = createController(ownedGeometry);
  } catch (error) {
    ownedGeometry.dispose();
    throw error;
  }
  try {
    if (isTouch) {
      joystickLayer = mountJoystickLayer(canvas);
      joystick = mountJoystick(joystickLayer.root, (x, y) => {
        currentWalk.setJoystickVector(x, y);
      });
    }
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    get walk(): WalkthroughHandle {
      return currentWalk;
    },
    get ready(): boolean {
      return ready;
    },
    onReady(listener: () => void): () => void {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
    loadCollision(data: ArrayBuffer, signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          signal.removeEventListener('abort', aborted);
          cancelParse = null;
        };
        const aborted = (): void => {
          finish();
          reject(new DOMException('Walk load canceled', 'AbortError'));
        };
        if (signal.aborted || disposed) { aborted(); return; }
        signal.addEventListener('abort', aborted, { once: true });
        cancelParse = aborted;
        try {
          new GLTFLoader().parse(data, '', (gltf) => {
            finish();
            const geometries = new Set<BufferGeometry>();
            gltf.scene.traverse((child) => {
              const geometry = (child as { geometry?: BufferGeometry }).geometry;
              if (geometry) geometries.add(geometry);
            });
            if (disposed || signal.aborted) {
              for (const geometry of geometries) geometry.dispose();
              aborted();
              return;
            }
            const mesh = gltf.scene.children[0] as { geometry?: BufferGeometry } | undefined;
            const geometry = mesh?.geometry;
            if (!geometry || !geometry.getAttribute('position')?.count ||
                (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) < 3) {
              for (const item of geometries) item.dispose();
              reject(new Error('collision mesh has no triangles'));
              return;
            }
            for (const item of geometries) if (item !== geometry) item.dispose();
            try {
              setupCollision(geometry);
              resolve();
            } catch (error) { reject(error); }
          }, (error) => { finish(); reject(error); });
        } catch (error) { finish(); reject(error); }
      });
    },
    setJoystickVisible(visible: boolean): void {
      joystick?.setVisible(visible);
    },
    dispose,
  };
}
