// The proof panel with the complete numbers definition and scripted orbit measure.

import './panel.css';
import type { ProofSnapshot } from './marks';
import type { GovernorEvent } from '../post/governor';
import { TIERS } from '../tiers/table';
import type { TierName } from '../tiers/table';

export interface PanelOptions {
  read: () => ProofSnapshot;
  measure: (signal: AbortSignal) => Promise<void>; // disables its button while the orbit runs
  intervalMs?: number | undefined;
}

export interface PanelHandle {
  refresh(): void;
  dispose(): void;
}

interface OrbitMeasurement {
  cpuP50: number;
  cpuP95: number;
  gpuP50: number | null;
  gpuP95: number | null;
  gpuAvailable: boolean;
  budgetMs: number;
  status: 'inside' | 'over';
}

const DEFAULT_INTERVAL_MS = 500;
// The content report and loading readout use decimal megabytes.
const BYTES_PER_MB = 1_000_000;

function formatMs(value: number | null): string {
  return value === null ? 'null' : `${value.toFixed(1)} ms`;
}

function isTierName(t: string): t is TierName {
  return t === 'base' || t === 'mid' || t === 'high';
}

/**
 * The tier reaches the panel as a plain string, so an unknown one needs an answer. It is the Mid
 * row of TIERS, read from the table rather than written out here: no frame budget may live in this
 * file, or the panel could print a number the tier table does not have.
 */
function tierBudgetMs(tier: string): number {
  if (isTierName(tier)) {
    return TIERS[tier].frameBudgetMs;
  }
  return TIERS.mid.frameBudgetMs;
}

function formatOrbit(orbit: OrbitMeasurement): string {
  const gpuText = !orbit.gpuAvailable
    ? 'GPU: not exposed by this backend'
    : orbit.gpuP50 === null
      ? 'GPU: no reading during the orbit'
      : `GPU p50: ${formatMs(orbit.gpuP50)}, p95: ${formatMs(orbit.gpuP95)}`;
  return (
    `CPU p50: ${formatMs(orbit.cpuP50)}, p95: ${formatMs(orbit.cpuP95)} | ` +
    `${gpuText} | ` +
    `budget: ${orbit.budgetMs.toFixed(1)} ms (${orbit.status})`
  );
}

/** The log arrives as the canvas's capped data-governor-log JSON; entries stay oldest-first. */
function formatGovernorLog(raw: string | undefined): string {
  if (raw === undefined || raw === '' || raw === 'off') {
    return 'no changes yet';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unreadable governor log';
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return 'no changes yet';
  }
  const lines: string[] = [];
  for (const entry of parsed) {
    const event = entry as Partial<GovernorEvent>;
    if (
      (event.direction !== 'down' && event.direction !== 'up') ||
      typeof event.from !== 'string' ||
      typeof event.to !== 'string' ||
      typeof event.reason !== 'string'
    ) {
      return 'unreadable governor log';
    }
    lines.push(`${event.direction} ${event.from} \u2192 ${event.to}; ${event.reason}`);
  }
  return lines.join(' | ');
}

export function mountProofPanel(root: HTMLElement, options: PanelOptions): PanelHandle {
  const lifetime = new AbortController();
  const section = document.createElement('section');
  section.className = 'proof-panel';
  section.setAttribute('aria-label', 'Proof');

  const dl = document.createElement('dl');
  dl.className = 'proof-panel__list';
  section.appendChild(dl);

  const actions = document.createElement('div');
  actions.className = 'proof-panel__actions';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'proof-panel__measure';
  button.textContent = 'Measure';
  actions.appendChild(button);

  const status = document.createElement('span');
  status.className = 'proof-panel__status';
  // The span is itself the live region, so only its own text changes are announced; a region on
  // the actions row would read the static Measure label out with every status change.
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  actions.appendChild(status);

  section.appendChild(actions);
  root.appendChild(section);

  let orbitResult: OrbitMeasurement | null = null;
  let orbitText = 'not measured';
  let governorLog: string | undefined;
  let governorText = 'no changes yet';
  let refreshCount = 0;

  const rows = new Map<string, { dt: HTMLElement; dd: HTMLElement }>();
  for (const term of [
    'load', 'scene files', 'all requests up to first frame', 'all requests so far',
    'draw calls', 'triangles', 'backend', 'tier',
    'pixel ratio', 'render scale', 'gpu', 'frame work p50 (cpu)', 'frame work p95 (cpu)',
    'gpu p50', 'gpu p95',
    'data-post', 'governor', 'governor log', 'cache', 'look switch', 'orbit',
  ]) {
    const dt = document.createElement('dt');
    dt.className = 'proof-panel__term';
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.className = 'proof-panel__desc';
    rows.set(term, { dt, dd });
    dl.append(dt, dd);
  }

  function setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) element.textContent = text;
  }

  function renderRow(term: string, desc: string): void {
    const row = rows.get(term)!;
    setText(row.dd, desc);
  }

  function refresh(): void {
    if (lifetime.signal.aborted) return;
    const snap = options.read();

    renderRow('load', formatMs(snap.loadMs));
    const scene = snap.sceneFiles;
    renderRow('scene files', scene == null ? 'not available' :
      `${(scene.bytes / BYTES_PER_MB).toFixed(2)} MB / ${(scene.budgetBytes / BYTES_PER_MB).toFixed(2)} MB ` +
      `(${scene.bytes <= scene.budgetBytes ? 'inside' : 'over'})`);
    renderRow('all requests up to first frame', `${snap.payloadBytes} bytes`);
    renderRow('all requests so far', `${snap.payloadNowBytes} bytes`);
    renderRow('draw calls', `${snap.drawCalls} calls`);
    renderRow('triangles', `${snap.triangles} triangles`);
    renderRow('backend', snap.backend);
    renderRow('tier', snap.tier);
    renderRow('pixel ratio', snap.pixelRatio.toFixed(2));
    renderRow('render scale', String(snap.renderScale));
    renderRow('gpu', snap.gpuName);
    renderRow('frame work p50 (cpu)', formatMs(snap.frameP50Ms));
    renderRow('frame work p95 (cpu)', formatMs(snap.frameP95Ms));

    // `available` is the series' own answer to "did this backend ever give a reading", which a
    // pair of nulls cannot tell apart from a window that has just been cleared for a Measure run.
    if (!snap.gpu.available) {
      setText(rows.get('gpu p50')!.dt, 'GPU');
      renderRow('gpu p50', 'not exposed by this backend');
      rows.get('gpu p95')!.dt.remove();
      rows.get('gpu p95')!.dd.remove();
    } else {
      setText(rows.get('gpu p50')!.dt, 'gpu p50');
      const second = rows.get('gpu p95')!;
      if (second.dt.parentNode !== dl) {
        const next = rows.get('data-post')!.dt;
        dl.insertBefore(second.dt, next);
        dl.insertBefore(second.dd, next);
      }
      renderRow('gpu p50', formatMs(snap.gpu.p50));
      renderRow('gpu p95', formatMs(snap.gpu.p95));
    }

    renderRow('data-post', snap.post);
    renderRow('governor', snap.governor ?? 'off');
    if (snap.governorLog !== governorLog) {
      governorLog = snap.governorLog;
      governorText = formatGovernorLog(governorLog);
    }
    renderRow('governor log', governorText);
    renderRow('cache', snap.cacheState);
    renderRow('look switch', formatMs(snap.lookSwitchMs));

    renderRow('orbit', orbitText);
    // Browser tests observe this completion counter, including refreshes with unchanged row text.
    refreshCount += 1;
    dl.dataset['refresh'] = String(refreshCount);
  }

  button.addEventListener('click', async () => {
    if (lifetime.signal.aborted || button.disabled) return;
    button.disabled = true;
    status.textContent = 'measuring...';
    try {
      await options.measure(lifetime.signal);
      if (lifetime.signal.aborted) return;
      const snap = options.read();
      const budget = tierBudgetMs(snap.tier);
      const check = snap.frameP95Ms <= budget ? 'inside' : 'over';
      const result: OrbitMeasurement = {
        cpuP50: snap.frameP50Ms,
        cpuP95: snap.frameP95Ms,
        gpuP50: snap.gpu.p50,
        gpuP95: snap.gpu.p95,
        gpuAvailable: snap.gpu.available,
        budgetMs: budget,
        status: check,
      };
      if (
        orbitResult === null || result.cpuP50 !== orbitResult.cpuP50 ||
        result.cpuP95 !== orbitResult.cpuP95 || result.gpuP50 !== orbitResult.gpuP50 ||
        result.gpuP95 !== orbitResult.gpuP95 || result.gpuAvailable !== orbitResult.gpuAvailable ||
        result.budgetMs !== orbitResult.budgetMs || result.status !== orbitResult.status
      ) {
        orbitText = formatOrbit(result);
        orbitResult = result;
      }
      status.textContent = '';
      refresh();
    } catch (error: unknown) {
      if (lifetime.signal.aborted) return;
      status.textContent = error instanceof Error ? error.message : 'measure failed';
    } finally {
      if (!lifetime.signal.aborted) button.disabled = false;
    }
  }, { signal: lifetime.signal });

  refresh();
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timer = window.setInterval(refresh, intervalMs);

  return {
    refresh,
    dispose(): void {
      lifetime.abort();
      window.clearInterval(timer);
      section.remove();
    },
  };
}
