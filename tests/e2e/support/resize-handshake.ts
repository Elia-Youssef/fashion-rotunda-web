/** Three floors each backing dimension after multiplying the CSS box by the applied ratio. */
const BACKING_ROUNDING_PX = 1;

export interface ResizeSnapshot {
  viewportWidth: number;
  viewportHeight: number;
  boxWidth: number;
  boxHeight: number;
  width: number;
  height: number;
  frames: number;
  scaler: {
    step: number;
    scale: number;
    steps: readonly number[];
    appliedPixelRatio: number;
    deterministic: boolean;
  } | null;
}

export interface ResizeViewport {
  width: number;
  height: number;
}

export interface ResizePoll {
  snapshot: ResizeSnapshot;
  checks: {
    viewport: boolean;
    cssDimensions: boolean;
    bufferDimensions: boolean;
    appliedResolution: boolean;
    aspect: boolean;
    newerFrame: boolean;
  };
  acknowledgedFrames: number | null;
  acknowledgedNow: boolean;
  sizeReady: boolean;
  ready: boolean;
}

/** Inspect the applied renderer ratio, independently of the scaler's requested step. */
function matchesAppliedResolution(snapshot: ResizeSnapshot): boolean {
  const ratio = snapshot.scaler?.appliedPixelRatio ?? NaN;
  const widthRounding = snapshot.boxWidth * ratio - snapshot.width;
  const heightRounding = snapshot.boxHeight * ratio - snapshot.height;
  return Number.isFinite(ratio) && ratio > 0 &&
    widthRounding >= 0 && widthRounding < BACKING_ROUNDING_PX &&
    heightRounding >= 0 && heightRounding < BACKING_ROUNDING_PX;
}

/** Shared by qualification and cooldown resizes; every observation is retained for failures. */
export class ResizeHandshake {
  readonly polls: ResizePoll[] = [];
  private acknowledgedFrames: number | null = null;

  constructor(
    readonly before: ResizeSnapshot,
    readonly viewport: ResizeViewport,
  ) {}

  poll(snapshot: ResizeSnapshot): ResizePoll {
    const ratioMin = Math.max(snapshot.width / snapshot.boxWidth, snapshot.height / snapshot.boxHeight);
    const ratioMax = Math.min(
      (snapshot.width + BACKING_ROUNDING_PX) / snapshot.boxWidth,
      (snapshot.height + BACKING_ROUNDING_PX) / snapshot.boxHeight,
    );
    const checks = {
      viewport: snapshot.viewportWidth === this.viewport.width && snapshot.viewportHeight === this.viewport.height,
      cssDimensions: snapshot.boxWidth > 0 && snapshot.boxHeight > 0 &&
        snapshot.boxWidth !== this.before.boxWidth && snapshot.boxHeight !== this.before.boxHeight,
      bufferDimensions: snapshot.width > 0 && snapshot.height > 0 &&
        snapshot.width !== this.before.width && snapshot.height !== this.before.height,
      appliedResolution: matchesAppliedResolution(snapshot),
      aspect: ratioMin < ratioMax,
      newerFrame: false,
    };
    const sizeReady = checks.viewport && checks.cssDimensions && checks.bufferDimensions &&
      checks.appliedResolution && checks.aspect;
    const acknowledgedNow = sizeReady && this.acknowledgedFrames === null && Number.isFinite(snapshot.frames);
    if (acknowledgedNow) {
      // A frame preceding resize delivery is insufficient, even if it advanced the old baseline.
      this.acknowledgedFrames = Math.max(this.before.frames, snapshot.frames);
    }
    checks.newerFrame = this.acknowledgedFrames !== null && Number.isFinite(snapshot.frames) &&
      snapshot.frames > this.acknowledgedFrames;
    const poll = {
      snapshot,
      checks,
      acknowledgedFrames: this.acknowledgedFrames,
      acknowledgedNow,
      sizeReady,
      ready: sizeReady && checks.newerFrame,
    };
    this.polls.push(poll);
    return poll;
  }

  failureMessage(message: string): string {
    return `${message}\nResize polls:\n${JSON.stringify({
      requestedViewport: this.viewport,
      before: this.before,
      polls: this.polls,
    }, null, 2)}`;
  }
}
