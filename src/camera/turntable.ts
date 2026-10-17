// The turntable. The look on the plinth turns at a steady rate while this runs; the
// product card's Rotate action and the Reset action drive it through toggle() and setYaw().
// Rotate is motion the visitor requested, so reduced motion does not gate it.
// Pure state: no three.js, no DOM, so the unit tests are arithmetic.

export interface TurntableOptions {
  degreesPerSecond: number;
  onChange: () => void;
}

export interface Turntable {
  start(): void;
  stop(): void;
  toggle(): void;
  readonly running: boolean;
  /** Advances while running; returns the current yaw in radians. */
  update(dtMs: number): number;
  setYaw(radians: number): void;
  readonly yaw: number;
}

export function createTurntable(options: TurntableOptions): Turntable {
  const radiansPerMs = (options.degreesPerSecond * Math.PI) / 180 / 1000;
  const onChange = options.onChange;

  let running = false;
  // The yaw grows without bound and is never wrapped: the showroom accepts any radians, and a
  // wrap would make one full turn read as a jump back to zero.
  let yaw = 0;

  function start(): void {
    if (running) {
      return;
    }
    running = true;
    onChange();
  }

  function stop(): void {
    if (!running) {
      return;
    }
    running = false;
    onChange();
  }

  return {
    start,
    stop,
    toggle(): void {
      if (running) {
        stop();
      } else {
        start();
      }
    },
    update(dtMs: number): number {
      if (running && dtMs > 0) {
        yaw += radiansPerMs * dtMs;
        onChange();
      }
      return yaw;
    },
    setYaw(radians: number): void {
      if (radians === yaw) {
        return;
      }
      yaw = radians;
      onChange();
    },
    get running(): boolean {
      return running;
    },
    get yaw(): number {
      return yaw;
    },
  };
}
