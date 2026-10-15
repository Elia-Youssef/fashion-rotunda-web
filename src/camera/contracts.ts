import type { BufferGeometry, PerspectiveCamera } from 'three';

export type CameraMode = 'orbit' | 'walk';

export interface WalkthroughOptions {
  camera: PerspectiveCamera;
  element: HTMLCanvasElement;
  collision: BufferGeometry; // metres, Y up
  eyeHeight: number;
  radius: number;
  walkSpeed: number; // metres per second; Shift doubles it
  isTouch: boolean;
  onChange: () => void;
  now?: () => number;
}

export interface WalkthroughHandle {
  enable(): void;
  disable(): void;
  readonly enabled: boolean;
  update(dtMs: number): boolean;
  setPose(foot: [number, number, number], yaw: number, pitch: number): void;
  readonly foot: [number, number, number];
  readonly yaw: number;
  readonly pitch: number;
  readonly moving: boolean;
  setJoystickVector(x: number, y: number): void;
  dispose(): void;
}

export interface WalkSessionOptions {
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
  collisionUrl: string;
  isTouch: boolean;
  onChange: () => void;
  now: () => number;
}

/** Owns the controller, collision request/geometry and touch controls together. */
export interface WalkSession {
  readonly walk: WalkthroughHandle;
  readonly ready: boolean;
  onReady(listener: () => void): () => void;
  setJoystickVisible(visible: boolean): void;
  dispose(): void;
}
