import type { ResizeSnapshot } from './resize-handshake';

// Representative replay of CSS changing before its buffer; these are fixture dimensions,
// not captured browser telemetry. The two sizes exercise an aspect change as well as a resize.
export const RESIZE_VIEWPORT = { width: 1000, height: 700 };
export const BEFORE_RESIZE: ResizeSnapshot = {
  viewportWidth: 1280,
  viewportHeight: 800,
  boxWidth: 1280,
  boxHeight: 800,
  width: 1280,
  height: 800,
  frames: 10,
  scaler: { step: 0, scale: 1, steps: [1, 0.85], appliedPixelRatio: 1, deterministic: true },
};
export const STALE_BUFFER: ResizeSnapshot = {
  ...BEFORE_RESIZE,
  viewportWidth: RESIZE_VIEWPORT.width,
  viewportHeight: RESIZE_VIEWPORT.height,
  boxWidth: RESIZE_VIEWPORT.width,
  boxHeight: RESIZE_VIEWPORT.height,
  frames: 11,
};
export const APPLIED_RESIZE: ResizeSnapshot = {
  ...STALE_BUFFER,
  width: RESIZE_VIEWPORT.width,
  height: RESIZE_VIEWPORT.height,
};
