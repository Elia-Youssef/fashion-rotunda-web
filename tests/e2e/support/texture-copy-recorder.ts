export interface CanvasAssignment {
  atMs: number;
  axis: 'width' | 'height';
  from: number;
  to: number;
  boxWidth: number;
  boxHeight: number;
}

interface CopyTexture {
  size: number[];
  origin: number[];
  mipLevel: number;
  format: string;
}

export interface OutOfRangeCopy {
  atMs: number;
  encoder: string;
  extent: number[];
  source: CopyTexture;
  destination: CopyTexture;
  canvas: number[] | null;
  post: string | null;
  stack: string;
}

export interface TextureCopyRecord {
  installed: boolean;
  copyCount: number;
  copies: OutOfRangeCopy[];
  canvas: CanvasAssignment[];
  errors: string[];
}

export interface TextureCopyWindow {
  __textureCopyRecord?: TextureCopyRecord;
}

/** Counts width growth after the checkpoint, comparing CSS boxes across full width assignments.
 * Height assignments happen in the same resize task and must not count a CSS resize a second time.
 */
export function canvasGrowths(record: readonly CanvasAssignment[], checkpoint: number): number {
  let previous: CanvasAssignment | undefined;
  let growths = 0;
  for (const [index, assignment] of record.entries()) {
    if (assignment.axis !== 'width') {
      continue;
    }
    if (
      index >= checkpoint && previous !== undefined && assignment.from > 0 &&
      assignment.to > assignment.from && assignment.boxWidth > 0 && assignment.boxHeight > 0 &&
      assignment.boxWidth === previous.boxWidth && assignment.boxHeight === previous.boxHeight
    ) {
      growths += 1;
    }
    previous = assignment;
  }
  return growths;
}

/** Self-contained for page.addInitScript: intercept native calls before WebGPU validation runs.
 * Native setters and copies still run, including invalid copies; recording never repairs the page.
 */
export function recordTextureCopies(): void {
  const record: TextureCopyRecord = {
    installed: false, copyCount: 0, copies: [], canvas: [], errors: [],
  };
  Object.defineProperty(window, '__textureCopyRecord', { value: record });

  for (const axis of ['width', 'height'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, axis);
    const get = descriptor?.get;
    const set = descriptor?.set;
    if (descriptor === undefined || get === undefined || set === undefined) {
      record.errors.push(`Missing native canvas ${axis} accessor`);
      continue;
    }
    Object.defineProperty(HTMLCanvasElement.prototype, axis, {
      configurable: descriptor.configurable ?? false,
      enumerable: descriptor.enumerable ?? false,
      get,
      set(this: HTMLCanvasElement, value: number): void {
        const from = Number(get.call(this));
        set.call(this, value);
        const to = Number(get.call(this));
        if (this.id === 'scene' && from !== to) {
          record.canvas.push({
            atMs: performance.now(), axis, from, to,
            boxWidth: this.clientWidth, boxHeight: this.clientHeight,
          });
        }
      },
    });
  }

  if (typeof GPUCommandEncoder === 'undefined') {
    record.errors.push('GPUCommandEncoder is unavailable');
    return;
  }
  const copy = GPUCommandEncoder.prototype.copyTextureToTexture;
  function textureInfo(info: GPUTexelCopyTextureInfo): CopyTexture {
    const { texture } = info;
    const mipLevel = info.mipLevel ?? 0;
    const mipSize = (size: number): number => Math.max(1, Math.floor(size / 2 ** mipLevel));
    const origin = info.origin;
    return {
      size: [
        mipSize(texture.width),
        texture.dimension === '1d' ? 1 : mipSize(texture.height),
        texture.dimension === '3d' ? mipSize(texture.depthOrArrayLayers) : texture.depthOrArrayLayers,
      ],
      origin: Array.isArray(origin)
        ? [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0]
        : [origin?.x ?? 0, origin?.y ?? 0, origin?.z ?? 0],
      mipLevel,
      format: texture.format,
    };
  }
  GPUCommandEncoder.prototype.copyTextureToTexture = function (source, destination, size): void {
    record.copyCount += 1;
    // WebIDL also accepts iterables. Materialize once so inspecting one cannot consume it twice.
    const copySize = 'width' in size ? size : Array.from(size);
    try {
      const extent = Array.isArray(copySize)
        ? [copySize[0], copySize[1] ?? 1, copySize[2] ?? 1]
        : [copySize.width, copySize.height ?? 1, copySize.depthOrArrayLayers ?? 1];
      const sourceInfo = textureInfo(source);
      const destinationInfo = textureInfo(destination);
      const outside = (info: CopyTexture): boolean => extent.some(
        (length, axis) => info.origin[axis] + length > info.size[axis],
      );
      if (outside(sourceInfo) || outside(destinationInfo)) {
        const canvas = document.querySelector<HTMLCanvasElement>('canvas#scene');
        record.copies.push({
          atMs: performance.now(), encoder: this.label, extent,
          source: sourceInfo, destination: destinationInfo,
          canvas: canvas === null ? null : [canvas.width, canvas.height],
          post: canvas?.dataset.post ?? null,
          stack: new Error().stack ?? '',
        });
      }
    } catch (error) {
      record.errors.push(String(error));
    }
    Reflect.apply(copy, this, [source, destination, copySize]);
  };
  record.installed = true;
}
