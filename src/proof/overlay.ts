// The proof overlay panel. The only proof module that touches the DOM.

import type { ProofSnapshot } from './marks';

export interface OverlayHandle {
  dispose(): void;
}

const DEFAULT_INTERVAL_MS = 500;

/** The overlay ships in production but stays off unless the URL asks for it; dev always shows it. */
export function overlayWanted(search: string, isDev: boolean): boolean {
  if (isDev) {
    return true;
  }
  return new URLSearchParams(search).get('proof') === '1';
}

/**
 * Mounts a <pre class="proof-overlay"> under `root`, refreshed every intervalMs. The caller
 * decides with overlayWanted whether to mount at all. `root` accepts null because the natural
 * call site is getElementById, and a missing container must not break startup.
 */
export function mountOverlay(
  root: HTMLElement | null,
  read: () => ProofSnapshot,
  options?: { intervalMs?: number },
): OverlayHandle {
  if (root === null) {
    return {
      dispose(): void {
        // Nothing was mounted, so there is nothing to tear down.
      },
    };
  }
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const pre = document.createElement('pre');
  pre.className = 'proof-overlay';
  const refresh = (): void => {
    pre.textContent = formatSnapshot(read());
  };
  refresh();
  root.appendChild(pre);
  const timer = window.setInterval(refresh, intervalMs);
  return {
    dispose(): void {
      window.clearInterval(timer);
      pre.remove();
    },
  };
}

/** One decimal: the clock's float noise (818.5999999940395) would otherwise fill the panel. */
function formatMs(value: number | null): string {
  return value === null ? 'null' : `${value.toFixed(1)} ms`;
}

/** One field per line with the unit stated, so a screenshot of the panel is self-describing. */
function formatSnapshot(snap: ProofSnapshot): string {
  return [
    `load: ${formatMs(snap.loadMs)}`,
    `payload: ${snap.payloadBytes} bytes`,
    `draw calls: ${snap.drawCalls} calls`,
    `triangles: ${snap.triangles} triangles`,
    `backend: ${snap.backend}`,
    `tier: ${snap.tier}`,
    `pixel ratio: ${snap.pixelRatio.toFixed(2)}`,
    `render scale: ${snap.renderScale}`,
    `gpu: ${snap.gpuName}`,
    `frame p50: ${formatMs(snap.frameP50Ms)}`,
    `frame p95: ${formatMs(snap.frameP95Ms)}`,
    `look switch: ${formatMs(snap.lookSwitchMs)}`,
  ].join('\n');
}
