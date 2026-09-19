// Backend support probing, kept apart from renderer creation so main.ts can decide between the
// poster path and the renderer path before anything touches the page's canvas.

export interface Support {
  /** `'gpu' in navigator` is the whole probe: browsers ship the property together with the API. */
  webgpu: boolean;
  /** True when a throwaway canvas answers `getContext('webgl2')` with a live context. */
  webgl2: boolean;
}

export function detectSupport(win: Window & typeof globalThis = window): Support {
  const webgpu = 'gpu' in win.navigator;

  // A detached canvas, so the probe never allocates a context on the page's own canvas. The
  // renderer would refuse that canvas later anyway, but not every caller renders at all.
  const canvas = win.document.createElement('canvas');
  const context = canvas.getContext('webgl2');

  return { webgpu, webgl2: context !== null };
}
