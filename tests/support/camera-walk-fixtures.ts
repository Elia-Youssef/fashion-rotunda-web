import { BoxGeometry, Group, Mesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { vi } from 'vitest';

import type { WalkLoader, WalkSession, WalkSessionOptions } from '../../src/camera/contracts';
import { createWalkSession } from '../../src/camera/walk-session';

/** Ready fixtures use real geometry/controller ownership without network or timing dependencies. */
export function readyWalkSession(options: WalkSessionOptions): WalkSession {
  const session = createWalkSession(options);
  const scene = new Group();
  scene.add(new Mesh(new BoxGeometry(20, 4, 0.4).translate(0, 2, 4)));
  const parser = vi.spyOn(GLTFLoader.prototype, 'parse').mockImplementationOnce((_data, _path, done) => {
    done({ scene } as GLTF);
  });
  void session.loadCollision(new ArrayBuffer(0), new AbortController().signal);
  parser.mockRestore();
  return session;
}

export function readyWalkLoader(options: WalkSessionOptions): WalkLoader {
  const session = readyWalkSession(options);
  return {
    state: 'ready', session,
    ensureReady: vi.fn(async () => session),
    cancel: vi.fn(),
    onStateChange: vi.fn(() => () => {}),
    dispose: () => session.dispose(),
  };
}
