// The shared renderer factory. Backend choice, device-loss wiring and the GPU
// name live here so the rest of the app deals with one handle and never with backend internals.
//
// Source references below are to the installed three.js 0.186.0 sources under
// node_modules/three/src/renderers/ and are quoted with file and line.

import { AgXToneMapping, WebGPURenderer } from 'three/webgpu';

import { separateViewportTextureSizes } from './viewport-texture';

export type Backend = 'webgpu' | 'webgl2';

export interface DeviceLostInfo {
  backend: Backend;
  /** What the renderer reported, or 'unknown' when it reported nothing readable. */
  reason: string;
  /** What the renderer reported, or '' when it reported nothing readable. */
  message: string;
}

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  /** The caller supplies this cap from the quality tier table. */
  pixelRatioCap: number;
  forceWebGL?: boolean;
  /** Enables the backend's timestamp queries; renderer.info.render.timestamp then reads GPU ms. */
  trackTimestamp?: boolean;
  onDeviceLost?: (info: DeviceLostInfo) => void;
  onError?: (error: unknown) => void;
}

export type CreateRendererOptions = RendererOptions;

export interface RendererHandle {
  renderer: WebGPURenderer;
  backend: Backend;
  /** Human-readable adapter name, or 'unknown' when neither backend exposes one. */
  gpuName: string;
  /** Restores the renderer callbacks this module replaced, then disposes the renderer. */
  dispose(): void;
}

/**
 * The one structural type in this module: a mirror of the object both backends pass to
 * `renderer.onDeviceLost` (Renderer.d.ts keeps its `DeviceLostInfo` interface unexported, so the
 * property's parameter type cannot be named). WebGPUBackend.js lines 270-275 build
 * `{ api, message, reason, originalEvent }` from `device.lost`; WebGLBackend.js lines 236-241
 * build the same shape from its `webglcontextlost` listener with `reason` always null.
 */
export interface RendererLossReport {
  api: 'WebGL' | 'WebGPU';
  message: string;
  reason: string | null;
  originalEvent: unknown;
}

/**
 * Flattens whatever a backend passed to `renderer.onDeviceLost` into the project's own shape.
 * Pure, so the unit tests cover every input shape without constructing a renderer. Reads go
 * through `in` checks and typeof guards; there is no cast anywhere in this file.
 */
export function normaliseLoss(backend: Backend, raw: unknown): DeviceLostInfo {
  const info: DeviceLostInfo = { backend, reason: 'unknown', message: '' };
  if (typeof raw === 'object' && raw !== null) {
    if ('reason' in raw && typeof raw.reason === 'string' && raw.reason.length > 0) {
      info.reason = raw.reason;
    }
    if ('message' in raw && typeof raw.message === 'string' && raw.message.length > 0) {
      info.message = raw.message;
    }
  }
  return info;
}

/**
 * The renderer types the backend as the abstract base, so the WebGPU-only flag is read through an
 * `in` check rather than a cast. WebGPUBackend.js line 92 sets `isWebGPUBackend = true`.
 */
function usesWebGPUBackend(backend: object): boolean {
  return 'isWebGPUBackend' in backend && backend.isWebGPUBackend === true;
}

/**
 * three 0.186.0 does not keep the adapter: WebGPUBackend.init() holds it in a local variable
 * (WebGPUBackend.js line 221) and only `this.device` survives init (line 296). The adapter, not
 * the device, carries the identifying `info`, so this module requests its own adapter. A second
 * `requestAdapter()` is cheap and normally resolves to the same physical GPU; when it fails or
 * every info field comes back empty, the badge shows 'unknown' instead.
 */
async function readWebGpuAdapterName(): Promise<string> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return 'unknown';
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) {
      return 'unknown';
    }
    const parts = [
      adapter.info.vendor,
      adapter.info.architecture,
      adapter.info.device,
      adapter.info.description,
    ];
    const name = parts.filter((part) => part.length > 0).join(' ');
    return name.length > 0 ? name : 'unknown';
  } catch {
    // Enumeration that worked a moment ago for the renderer can still fail for a second call;
    // a missing name must never fail startup.
    return 'unknown';
  }
}

/**
 * `renderer.getContext()` returns the backend's own context (Renderer.js line 2137 returns
 * `this.backend.getContext()`, and WebGLBackend.js line 461 returns `this.gl`, set at line 251),
 * typed as `unknown`. `WEBGL_debug_renderer_info` exposes its enum constant as a property of the
 * extension object, which lib.dom types loosely, so every read below is narrowed by `in` and
 * typeof checks before use. Browsers that mask the extension return null from `getExtension`.
 */
function readWebGlRendererName(context: unknown): string {
  if (!(context instanceof WebGL2RenderingContext)) {
    return 'unknown';
  }
  const extension: unknown = context.getExtension('WEBGL_debug_renderer_info');
  if (typeof extension !== 'object' || extension === null || !('UNMASKED_RENDERER_WEBGL' in extension)) {
    return 'unknown';
  }
  const constant = extension.UNMASKED_RENDERER_WEBGL;
  if (typeof constant !== 'number') {
    return 'unknown';
  }
  const reported: unknown = context.getParameter(constant);
  return typeof reported === 'string' && reported.length > 0 ? reported : 'unknown';
}

/**
 * A renderer error as one line of text. The WebGPU backend reports `{ api, type, message,
 * originalEvent }` (WebGPUBackend.js lines 287-292), and a console preview of that object cuts the
 * message short, which is the part that names the failing pass or texture. Pure, like normaliseLoss.
 */
export function describeRendererError(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null && 'message' in raw && typeof raw.message === 'string') {
    const head: string[] = [];
    if ('api' in raw && typeof raw.api === 'string') {
      head.push(raw.api);
    }
    if ('type' in raw && typeof raw.type === 'string') {
      head.push(raw.type);
    }
    return head.length > 0 ? `${head.join(' ')}: ${raw.message}` : raw.message;
  }
  return String(raw);
}

/**
 * The two callback slots this module overrides, as the renderer exposes them (Renderer.js lines 595
 * and 606, typed in Renderer.d.ts lines 255 and 265). Structural on purpose: the unit test installs the
 * handlers on a stand-in and calls them directly, which jsdom cannot do with a real renderer.
 */
export interface LossTarget {
  onDeviceLost: (info: RendererLossReport) => void;
  onError: (errorMessage: string) => void;
}

export type LossHandlers = Pick<CreateRendererOptions, 'onDeviceLost' | 'onError'>;

/**
 * Both backends route loss through `renderer.onDeviceLost`: the WebGPU backend from `device.lost`
 * (WebGPUBackend.js lines 266-279), the WebGL backend from its own `webglcontextlost` listener
 * (WebGLBackend.js lines 232-249), which it also removes on dispose (WebGLBackend.js line 2944). No
 * canvas listener of our own is needed. The device-lost slot is chained behind the default instead of
 * replaced, because the default sets the `_isDeviceLost` flag that stops render() after a loss
 * (Renderer.js lines 1656 and 1360). That default is a method writing `this._isDeviceLost`, so it must
 * run with the target as `this`: called bare it throws, and the notice never appears.
 * The WEBGL_lose_context check verifies this binding.
 *
 * `onError` is replaced rather than chained: @types/three declares it as `(errorMessage: string) =>
 * void` (Renderer.d.ts line 265), but the WebGPU backend passes an object `{ api, type, message,
 * originalEvent }` (WebGPUBackend.js lines 287-292), so the default's declared type cannot describe
 * the real payload. The default only logs, and the caller's own `onError` logging replaces it.
 *
 * Returns the function that puts both defaults back.
 */
export function installLossHandlers(
  target: LossTarget,
  backend: Backend,
  handlers: LossHandlers,
): () => void {
  const defaultOnDeviceLost = target.onDeviceLost;
  const defaultOnError = target.onError;

  target.onDeviceLost = (raw: unknown): void => {
    const info = normaliseLoss(backend, raw);
    // The default keeps its own message/reason format (Renderer.js lines 1350-1358); the fields it
    // reads are rebuilt from the normalised info so it logs what actually arrived.
    const report: RendererLossReport = {
      api: backend === 'webgpu' ? 'WebGPU' : 'WebGL',
      message: info.message,
      reason: info.reason === 'unknown' ? null : info.reason,
      originalEvent: raw,
    };
    defaultOnDeviceLost.call(target, report);
    handlers.onDeviceLost?.(info);
  };

  target.onError = (raw: unknown): void => {
    handlers.onError?.(raw);
  };

  return (): void => {
    target.onDeviceLost = defaultOnDeviceLost;
    target.onError = defaultOnError;
  };
}

export async function createRenderer(options: CreateRendererOptions): Promise<RendererHandle> {
  // Before any frame: the dome glass's framebuffer textures must each follow their own render
  // target's size, or a pixel-ratio step leaves one at a stale size (viewport-texture.ts).
  separateViewportTextureSizes();
  // `forceWebGL: false` reaches the constructor as an explicit false, which selects the WebGPU
  // backend exactly like an omitted property would (WebGPURenderer.js line 57 checks truthiness).
  const renderer = new WebGPURenderer({
    canvas: options.canvas,
    // Antialias covers the default framebuffer only; the post chain sets its own MSAA on the
    // scene pass.
    antialias: true,
    forceWebGL: options.forceWebGL === true,
    ...(options.trackTimestamp !== undefined ? { trackTimestamp: options.trackTimestamp } : {}),
  });

  // init() may swap in the WebGL backend through the automatic fallback (WebGPURenderer.js lines
  // 65-71 install it when the WebGPU backend cannot initialize), so the backend is detected
  // after the await, never from the options.
  await renderer.init();

  const backend: Backend = usesWebGPUBackend(renderer.backend) ? 'webgpu' : 'webgl2';
  // The smoke tests assert this attribute; keep the exact spelling.
  options.canvas.dataset.backend = backend;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, options.pixelRatioCap));
  renderer.toneMapping = AgXToneMapping;
  // outputColorSpace stays at the default SRGBColorSpace (Renderer.js line 184).

  const restoreLossHandlers = installLossHandlers(renderer, backend, options);

  const gpuName =
    backend === 'webgpu'
      ? await readWebGpuAdapterName()
      : readWebGlRendererName(renderer.getContext());

  return {
    renderer,
    backend,
    gpuName,
    dispose(): void {
      // Undo the two overrides first so a late loss cannot reach a torn-down page, then hand the
      // rest to the renderer, which also drops the WebGL backend's context-lost listener.
      restoreLossHandlers();
      void renderer.dispose();
    },
  };
}
