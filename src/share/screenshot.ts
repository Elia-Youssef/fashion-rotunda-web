// Screenshot capture at scale and delivery through Web Share or download.
// Reads pixel ratio and drawing buffer methods cited from three.js:
// node_modules/three/src/renderers/common/Renderer.js:
// - getPixelRatio (line 2146)
// - getDrawingBufferSize (line 2158)
// - setPixelRatio (line 2181)

export interface ScreenshotOptions {
  renderer: { getPixelRatio(): number; setPixelRatio(value: number): void };
  canvas: HTMLCanvasElement;
  /** Draws one frame at the current pixel ratio, synchronously; the composition root passes drawFrame. */
  drawFrame: () => void;
  /** Multiplier over the current pixel ratio. */
  scale: number;
}

/** Draws one frame at scale, reads the canvas as a PNG blob in the same task, restores the ratio. */
export function captureStill(options: ScreenshotOptions): Promise<Blob> {
  const { renderer, canvas, drawFrame, scale } = options;
  const previousRatio = renderer.getPixelRatio();
  const scaledRatio = previousRatio * scale;

  renderer.setPixelRatio(scaledRatio);
  try {
    drawFrame();

    // HTMLCanvasElement.toBlob is called in the exact same task as drawFrame before
    // the GPU back-buffer can be swapped or modified by another frame.
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob !== null) {
          resolve(blob);
        } else {
          reject(new Error('Canvas toBlob produced a null blob'));
        }
      }, 'image/png');
    });
  } finally {
    // A draw that throws would otherwise leave the page rendering at twice the ratio for the rest
    // of the visit, which costs four times the pixels on every later frame.
    renderer.setPixelRatio(previousRatio);
  }
}

/**
 * Downloads the blob as `fashion-rotunda-<look>-<yyyymmdd-hhmmss>.png`, or shares it on a device
 * that can.
 */
export async function deliverStill(
  blob: Blob,
  fileName: string,
  signal?: AbortSignal,
): Promise<'downloaded' | 'shared'> {
  signal?.throwIfAborted();
  // Mobile / capable devices with Web Share API and file sharing support
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function'
  ) {
    try {
      const file = new File([blob], fileName, { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: fileName,
        });
        signal?.throwIfAborted();
        return 'shared';
      }
    } catch (error) {
      // Retiring the owner cancels delivery; a live dismissal still downloads below.
      signal?.throwIfAborted();
      // A dismissed share sheet throws AbortError. Reporting that as 'shared' would tell the
      // visitor the still left the page when nothing did, so every failure, cancelled or not,
      // falls through to the download and the page says the still was saved because it was.
      if (!(error instanceof Error) || error.name !== 'AbortError') {
        console.warn('[archviz] the share sheet refused the still, downloading it', error);
      }
    }
  }

  signal?.throwIfAborted();
  // Standard download via temporary object URL
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);

  return 'downloaded';
}
