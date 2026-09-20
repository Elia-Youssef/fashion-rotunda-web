// Goal G2.8 and G6.4: The proof panel with the complete numbers definition and scripted orbit measure.

import './panel.css';
import type { ProofSnapshot } from './marks';
import { TIERS } from '../tiers/table';
import type { TierName } from '../tiers/table';

// One rule, one home: the panel and the <pre> variant answer the same question, so the panel
// re-exports the predicate instead of carrying a second copy that can drift from it.
export { overlayWanted } from './overlay';

export interface PanelOptions {
  read: () => ProofSnapshot;
  measure: () => Promise<void>; // runs the orbit; the panel disables its button meanwhile
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

export function mountProofPanel(root: HTMLElement, options: PanelOptions): PanelHandle {
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
  actions.appendChild(status);

  section.appendChild(actions);
  root.appendChild(section);

  let orbitResult: OrbitMeasurement | null = null;

  function renderRow(term: string, desc: string): void {
    const dt = document.createElement('dt');
    dt.className = 'proof-panel__term';
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.className = 'proof-panel__desc';
    dd.textContent = desc;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function refresh(): void {
    const snap = options.read();
    dl.replaceChildren();

    renderRow('load', formatMs(snap.loadMs));
    renderRow('payload', `${snap.payloadBytes} bytes`);
    renderRow('payload now', `${snap.payloadNowBytes} bytes`);
    renderRow('draw calls', `${snap.drawCalls} calls`);
    renderRow('triangles', `${snap.triangles} triangles`);
    renderRow('backend', snap.backend);
    renderRow('tier', snap.tier);
    renderRow('pixel ratio', snap.pixelRatio.toFixed(2));
    renderRow('render scale', String(snap.renderScale));
    renderRow('gpu', snap.gpuName);
    renderRow('frame p50', formatMs(snap.frameP50Ms));
    renderRow('frame p95', formatMs(snap.frameP95Ms));

    // `available` is the series' own answer to "did this backend ever give a reading", which a
    // pair of nulls cannot tell apart from a window that has just been cleared for a Measure run.
    if (!snap.gpu.available) {
      renderRow('GPU', 'not exposed by this backend');
    } else {
      renderRow('gpu p50', formatMs(snap.gpu.p50));
      renderRow('gpu p95', formatMs(snap.gpu.p95));
    }

    renderRow('data-post', snap.post);
    renderRow('cache', snap.cacheState);
    renderRow('look switch', formatMs(snap.lookSwitchMs));

    if (orbitResult !== null) {
      renderRow('orbit', formatOrbit(orbitResult));
    } else {
      renderRow('orbit', 'not measured');
    }
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'measuring...';
    try {
      await options.measure();
      const snap = options.read();
      const budget = tierBudgetMs(snap.tier);
      const check = snap.frameP95Ms <= budget ? 'inside' : 'over';
      orbitResult = {
        cpuP50: snap.frameP50Ms,
        cpuP95: snap.frameP95Ms,
        gpuP50: snap.gpu.p50,
        gpuP95: snap.gpu.p95,
        gpuAvailable: snap.gpu.available,
        budgetMs: budget,
        status: check,
      };
      status.textContent = '';
      refresh();
    } catch (error: unknown) {
      status.textContent = error instanceof Error ? error.message : 'measure failed';
    } finally {
      button.disabled = false;
    }
  });

  refresh();
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timer = window.setInterval(refresh, intervalMs);

  return {
    refresh,
    dispose(): void {
      window.clearInterval(timer);
      section.remove();
    },
  };
}
