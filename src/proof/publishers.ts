import type { PostChain } from '../post/chain';
import type { GovernorDiagnostics } from '../post/governor';

/**
 * The data-governor bridge: fixed-order, bounded tokens read by the proof snapshot, the panel and
 * the e2e suite. 'off' means no governor runs this page (WebGL 2, a tier with neither SSGI nor SSR
 * (Base and Mid), a forced `?post=` slice, or pass-through). The budget and threshold texts are
 * formatted only when they change, and the immutable event history is serialized once per history
 * version instead of on every frame.
 */
export function createGovernorPublisher(dataset: DOMStringMap): (diagnostics: GovernorDiagnostics | null) => void {
  let previousVersion = -1;
  let historyText = '[]';
  let previousBudget: number | null = null;
  let previousThreshold: number | null = null;
  let budgetText = '';
  let thresholdText = '';

  return (diagnostics): void => {
    let status = 'off';
    if (diagnostics !== null) {
      if (previousBudget !== diagnostics.budgetMs) {
        previousBudget = diagnostics.budgetMs;
        budgetText = diagnostics.budgetMs.toFixed(1);
      }
      if (previousThreshold !== diagnostics.recoveryThresholdMs) {
        previousThreshold = diagnostics.recoveryThresholdMs;
        thresholdText = diagnostics.recoveryThresholdMs.toFixed(2);
      }
      const p95 = diagnostics.lastP95Ms === null ? 'none' : diagnostics.lastP95Ms.toFixed(1);
      status = `level=${diagnostics.level};activity=${diagnostics.activity}` +
        `;eligible=${diagnostics.recoveryEligible ? '1' : '0'}` +
        `;cooldown=${Math.ceil(diagnostics.cooldownRemainingMs)}` +
        `;patience=${diagnostics.consecutiveOverBudget}/${diagnostics.patience}` +
        `;qualify=${Math.floor(diagnostics.recoveryElapsedMs)}/${diagnostics.recoveryQualificationMs}` +
        `;p95=${p95};budget=${budgetText};threshold=${thresholdText}`;
      if (previousVersion !== diagnostics.historyVersion) {
        previousVersion = diagnostics.historyVersion;
        historyText = JSON.stringify(diagnostics.events);
      }
    }
    if (dataset['governor'] !== status) {
      dataset['governor'] = status;
    }
    const log = diagnostics === null ? '[]' : historyText;
    if (dataset['governorLog'] !== log) {
      dataset['governorLog'] = log;
    }
  };
}

/**
 * The post-state publisher: the features string in its fixed order, built only when the chain
 * hands out a features record this publisher has not seen. The chain reuses one record until a
 * published value would change (a graph rebuild, a fallback, or a motion or depth-of-field
 * transition), so an ordinary frame formats nothing; the governor record still rides every call.
 * The starting sentinel is undefined, so even a first null call writes 'off' exactly as the
 * per-frame formatting this replaces did.
 */
export function createPostStatePublisher(
  dataset: DOMStringMap,
  publishGovernor: (diagnostics: GovernorDiagnostics | null) => void,
): (features: PostChain['features'] | null, diagnostics: GovernorDiagnostics | null) => void {
  let published: PostChain['features'] | null | undefined;
  return (features, diagnostics) => {
    if (features !== published) {
      published = features;
      const value =
        features === null
          ? 'off'
          : [
              features.ao ? 'ao' : '',
              features.traa ? 'traa' : '',
              features.msaa ? 'msaa' : '',
              features.ssgi === 'half' ? 'ssgi-half' : features.ssgi === 'full' ? 'ssgi' : '',
              features.ssr ? 'ssr' : '',
              features.bloom ? 'bloom' : '',
              features.lut ? 'lut' : '',
              features.vignette ? 'vignette' : '',
              features.dof === 'on' ? 'dof' : '',
            ]
              .filter((feature) => feature !== '')
              .join(',') || 'off';
      if (dataset['post'] !== value) {
        dataset['post'] = value;
      }
    }
    publishGovernor(diagnostics);
  };
}

/**
 * The memory attribute as the e2e switch test reads it: geometries/textures. Both counts are
 * lifetime totals of live objects and only move when a resource is uploaded or disposed, so the
 * counts are compared as numbers and the string is built only for a change; a still page touches
 * the dataset neither to read nor to write. The sentinels are negative, so the first call always
 * writes, exactly as the compare-against-the-attribute form this replaces did.
 */
export function createMemoryPublisher(
  dataset: DOMStringMap,
): (geometries: number, textures: number) => void {
  let lastGeometries = -1;
  let lastTextures = -1;
  return (geometries, textures) => {
    if (geometries === lastGeometries && textures === lastTextures) {
      return;
    }
    lastGeometries = geometries;
    lastTextures = textures;
    dataset['memory'] = `${geometries}/${textures}`;
  };
}

/**
 * The proof timestamp bridge: at most one resolve in flight. Both query pools already coalesce a
 * resolve issued while one is running and answer it with the same duration
 * (WebGPUTimestampQueryPool.js lines 104-106; the WebGL pool keeps the same flag at lines
 * 190-196), and the backend writes exactly what the pool returned into info.render.timestamp
 * (Backend.js, resolveTimestampsAsync), so a call skipped here cannot make the standing reading
 * staler: it only skips a duplicate write of the same number and its promise chain. The reading
 * is pushed before the resolve is requested, so what the series records is unchanged either way.
 */
export function createTimestampResolveBridge(
  resolve: () => Promise<unknown>,
  onError: (error: unknown) => void,
): () => void {
  let inFlight = false;
  const settled = (): void => {
    inFlight = false;
  };
  const failed = (error: unknown): void => {
    inFlight = false;
    onError(error);
  };
  return () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    void resolve().then(settled, failed);
  };
}

