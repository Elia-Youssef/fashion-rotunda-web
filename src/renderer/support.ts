// Backend support probing, kept apart from renderer creation so main.ts can decide between the
// poster path and the renderer path before anything touches the page's canvas.
//
// Presence of an API says nothing: a browser can expose navigator.gpu and
// WebGL2RenderingContext while granting neither an adapter nor a context, for example through
// driver or enterprise flags. Support therefore means what can actually start: WebGPU counts
// only when an adapter answers, WebGL 2 only when a context answers.

export interface Support {
  /** True only when an adapter request resolved to a live adapter. */
  webgpu: boolean;
  /** True when a throwaway canvas answers `getContext('webgl2')` with a live context. */
  webgl2: boolean;
}

/** Asks the browser for a real adapter; null and a thrown request both mean "cannot start". */
async function canStartWebGpu(win: Window & typeof globalThis): Promise<boolean> {
  const nav: Navigator = win.navigator;
  if (!('gpu' in nav) || typeof nav.gpu?.requestAdapter !== 'function') {
    return false;
  }
  try {
    return (await nav.gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

function canStartWebGl2(win: Window & typeof globalThis): boolean {
  // A detached canvas, so the probe never allocates a context on the page's own canvas. The
  // renderer would refuse that canvas later anyway, but not every caller renders at all.
  const canvas = win.document.createElement('canvas');
  try {
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

export async function detectSupport(win: Window & typeof globalThis = window): Promise<Support> {
  const webgpu = await canStartWebGpu(win);
  const webgl2 = canStartWebGl2(win);
  return { webgpu, webgl2 };
}
