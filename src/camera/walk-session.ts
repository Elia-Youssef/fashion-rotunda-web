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

/** Eager Walk ownership; the existing zero-delay collision preload remains unchanged. */
export function createWalkSession(options: WalkSessionOptions): WalkSession {
  const { camera, canvas, collisionUrl, isTouch, onChange, now } = options;
  let currentWalk: WalkthroughHandle | null = null;
  let ownedGeometry: BufferGeometry | null = new BufferGeometry();
  let joystick: JoystickHandle | null = null;
  let joystickLayer: JoystickLayer | null = null;
  let collisionTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let collisionAbort: AbortController | null = null;
  let disposed = false;
  let ready = false;
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
    if (collisionTimeoutId !== null) clearTimeout(collisionTimeoutId);
    collisionAbort?.abort();
    currentWalk?.dispose();
    joystick?.dispose();
    joystickLayer?.dispose();
    ownedGeometry?.dispose();
    readyListeners.clear();
  }

  function setupCollision(geometry: BufferGeometry): void {
    const previous = currentWalk!;
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

  try {
    // Keep the placeholder handle and early touch mount until readiness is made asynchronous.
    currentWalk = createController(ownedGeometry);
    if (isTouch) {
      joystickLayer = mountJoystickLayer(canvas);
      joystick = mountJoystick(joystickLayer.root, (x, y) => {
        currentWalk!.setJoystickVector(x, y);
      });
    }

    // Fetch owns cancellation; GLTFLoader parses the same collision response as before.
    if (collisionUrl) {
      collisionTimeoutId = setTimeout(() => {
        try {
          collisionAbort = new AbortController();
          const loader = new GLTFLoader();
          void fetch(collisionUrl, { signal: collisionAbort.signal })
            .then((response) => {
              if (!response.ok) throw new Error(`collision mesh answered ${response.status}`);
              return response.arrayBuffer();
            })
            .then((data) => {
              if (disposed) return;
              loader.parse(
                data,
                '',
                (gltf) => {
                  const mesh = gltf.scene.children[0] as { geometry?: BufferGeometry };
                  if (disposed) {
                    mesh?.geometry?.dispose();
                  } else if (mesh?.geometry) {
                    setupCollision(mesh.geometry);
                  }
                },
                (err) => {
                  if (!disposed) console.warn('[archviz] failed to parse collision mesh', err);
                },
              );
            })
            .catch((err: unknown) => {
              if (!disposed && !(err instanceof DOMException && err.name === 'AbortError')) {
                console.warn('[archviz] failed to load collision mesh', err);
              }
            });
        } catch {
          // Ignored if loader URL resolution fails in test environments.
        }
      }, 0);
    }
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    get walk(): WalkthroughHandle {
      return currentWalk!;
    },
    get ready(): boolean {
      return ready;
    },
    onReady(listener: () => void): () => void {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
    setJoystickVisible(visible: boolean): void {
      joystick?.setVisible(visible);
    },
    dispose,
  };
}
