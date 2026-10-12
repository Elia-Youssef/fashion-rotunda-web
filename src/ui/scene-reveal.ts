// Two-stage black reveal transition coordinator.
// The lobby owns the visible cover-to-black. This coordinator then owns a DOM black veil while
// it proves that real scene frames have completed before the scene is allowed to become visible.

import './scene-reveal.css';

import type { EntryLobby } from './entry-lobby';

export type RevealState =
  | 'idle'
  | 'loading'
  | 'ready-hidden'
  | 'cover-to-black'
  | 'black-hold'
  | 'revealing'
  | 'revealed'
  | 'error'
  | 'disposed';

export interface ReadinessPredicates {
  rendererExists: () => boolean;
  backendActive: () => boolean;
  canvasSized: () => boolean;
  tierSettled: () => boolean;
  showroomExists: () => boolean;
  staticsMounted: () => boolean;
  lookAndVariantMounted: () => boolean;
  cameraPoseActive: () => boolean;
  lightingAttached: () => boolean;
  postChainAssembled: () => boolean;
  shadersCompiled: () => boolean;
  noError: () => boolean;
  realFrameCompleted: () => boolean;
}

export interface SceneRevealOptions {
  root?: HTMLElement;
  canvas: HTMLCanvasElement;
  search: string;
  lobby: EntryLobby | null;
  predicates: ReadinessPredicates;
  wakeRenderer: () => void;
  /** Resolves only after one real, scheduled scene render has completed. */
  onFrameRequest: () => Promise<void>;
  onRevealing?: () => void;
  onRevealed?: () => void;
  onError?: (error: Error | string) => void;
}

export interface TransitionTimestamps {
  readyHidden: number | null;
  coverStart: number | null;
  coverEnd: number | null;
  holdStart: number | null;
  holdEnd: number | null;
  revealStart: number | null;
  revealEnd: number | null;
}

export interface TransitionSeam {
  readonly state: RevealState;
  readonly timestamps: TransitionTimestamps;
  readonly stableFrames: number;
  readPredicates(): Record<string, boolean>;
  unfreeze(): void;
}

declare global {
  interface Window {
    archvizTransitionSeam?: TransitionSeam;
  }
}

export const READY_HIDDEN_HOLD_MS = 250;
export const COVER_TO_BLACK_MS = 250;
export const BLACK_HOLD_MIN_MS = 200;
export const REVEAL_MS = 600;

function isReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function isTransitionState(state: RevealState): boolean {
  return state === 'ready-hidden' || state === 'cover-to-black' || state === 'black-hold' || state === 'revealing';
}

export class SceneRevealCoordinator {
  private currentState: RevealState = 'ready-hidden';
  private readonly veilElement: HTMLElement;
  private readonly options: SceneRevealOptions;
  private stableFrames = 0;
  private disposed = false;
  private failed = false;
  private frozenState: RevealState | null = null;
  private unfreezeResolver: (() => void) | null = null;
  private visibilityResolver: (() => void) | null = null;
  private restartGeneration = 0;

  private readonly timestamps: TransitionTimestamps = {
    readyHidden: performance.now(),
    coverStart: null,
    coverEnd: null,
    holdStart: null,
    holdEnd: null,
    revealStart: null,
    revealEnd: null,
  };

  private activeTimers: number[] = [];
  private pendingWaitResolvers: (() => void)[] = [];
  private readonly abortController = new AbortController();

  private lastWidth = 0;
  private lastHeight = 0;
  private lastDpr = 1;

  constructor(options: SceneRevealOptions) {
    this.options = options;
    const doc = options.root?.ownerDocument ?? document;
    const root = options.root ?? doc.body;

    let veil = root.querySelector<HTMLElement>('#scene-veil');
    if (veil === null) {
      veil = doc.createElement('div');
      veil.id = 'scene-veil';
      veil.setAttribute('aria-hidden', 'true');
      root.appendChild(veil);
    }
    this.veilElement = veil;
    this.setVeilState('ready-hidden');

    this.recordGeometry();
    this.installLifecycleGuards();
    this.setupTestSeam();
  }

  public get state(): RevealState {
    return this.currentState;
  }

  public get veil(): HTMLElement {
    return this.veilElement;
  }

  public get frameCountBehindBlack(): number {
    return this.stableFrames;
  }

  public get transitionTimestamps(): TransitionTimestamps {
    return { ...this.timestamps };
  }

  /** Fails closed from renderer errors or device loss without hiding the retry/reload recovery UI. */
  public fail(error: Error | string): void {
    if (this.disposed || this.failed || this.currentState === 'revealed') {
      return;
    }
    this.failed = true;
    this.currentState = 'error';
    this.stopAsyncWork();
    this.setVeilState('error');
    this.veilElement.hidden = true;
    this.veilElement.style.display = 'none';
    const message = error instanceof Error ? error.message : String(error);
    this.options.lobby?.setError(message);
    this.options.onError?.(message);
  }

  private recordGeometry(): void {
    if (typeof window !== 'undefined') {
      this.lastWidth = window.innerWidth;
      this.lastHeight = window.innerHeight;
      this.lastDpr = window.devicePixelRatio;
    }
  }

  private geometryChanged(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    return (
      window.innerWidth !== this.lastWidth ||
      window.innerHeight !== this.lastHeight ||
      window.devicePixelRatio !== this.lastDpr
    );
  }

  private setVeilState(state: RevealState): void {
    this.veilElement.hidden = false;
    this.veilElement.style.removeProperty('display');
    this.veilElement.dataset.state = state;
  }

  private setupTestSeam(): void {
    const params = new URLSearchParams(this.options.search);
    const isE2E = params.get('e2e') === '1' && params.get('gate') === 'on';
    if (!isE2E || typeof window === 'undefined') {
      return;
    }

    const freezeParam = params.get('freeze');
    if (
      freezeParam === 'ready-hidden' ||
      freezeParam === 'cover-to-black' ||
      freezeParam === 'black-hold' ||
      freezeParam === 'revealing'
    ) {
      this.frozenState = freezeParam;
    }

    const getState = (): RevealState => this.currentState;
    const getStableFrames = (): number => this.stableFrames;
    window.archvizTransitionSeam = {
      get state(): RevealState {
        return getState();
      },
      timestamps: this.timestamps,
      get stableFrames(): number {
        return getStableFrames();
      },
      readPredicates: () => this.evaluatePredicates(),
      unfreeze: () => {
        this.frozenState = null;
        this.veilElement.removeAttribute('data-e2e-freeze');
        const resume = this.unfreezeResolver;
        this.unfreezeResolver = null;
        resume?.();
      },
    };
  }

  private installLifecycleGuards(): void {
    const { signal } = this.abortController;
    if (typeof document !== 'undefined') {
      document.addEventListener(
        'visibilitychange',
        () => {
          if (document.hidden) {
            this.requestRestabilization();
          } else {
            this.recordGeometry();
            this.options.wakeRenderer();
            const resume = this.visibilityResolver;
            this.visibilityResolver = null;
            resume?.();
          }
        },
        { signal },
      );
    }

    if (typeof window !== 'undefined') {
      const disrupt = (): void => this.requestRestabilization();
      window.addEventListener('resize', disrupt, { signal });
      window.addEventListener('orientationchange', disrupt, { signal });
      window.visualViewport?.addEventListener('resize', disrupt, { signal });
    }
  }

  /** Makes the screen black immediately and invalidates every frame sampled before the disruption. */
  private requestRestabilization(): void {
    if (this.disposed || this.failed || !isTransitionState(this.currentState)) {
      return;
    }
    this.restartGeneration += 1;
    this.stableFrames = 0;
    this.currentState = 'black-hold';
    this.setVeilState('black-hold');
    this.options.lobby?.setBlackHold();
    this.options.wakeRenderer();
  }

  private async waitUntilVisible(): Promise<void> {
    while (typeof document !== 'undefined' && document.hidden && !this.disposed && !this.failed) {
      await new Promise<void>((resolve) => {
        this.visibilityResolver = resolve;
      });
    }
  }

  public evaluatePredicates(): Record<string, boolean> {
    const p = this.options.predicates;
    return {
      rendererExists: p.rendererExists(),
      backendActive: p.backendActive(),
      canvasSized: p.canvasSized(),
      tierSettled: p.tierSettled(),
      showroomExists: p.showroomExists(),
      staticsMounted: p.staticsMounted(),
      lookAndVariantMounted: p.lookAndVariantMounted(),
      cameraPoseActive: p.cameraPoseActive(),
      lightingAttached: p.lightingAttached(),
      postChainAssembled: p.postChainAssembled(),
      shadersCompiled: p.shadersCompiled(),
      noError: p.noError(),
      realFrameCompleted: p.realFrameCompleted(),
      documentVisible: typeof document === 'undefined' ? true : !document.hidden,
      geometryStable: !this.geometryChanged(),
    };
  }

  public areAllPredicatesSatisfied(): { ok: boolean; failed: string[] } {
    const readings = this.evaluatePredicates();
    const failed = Object.entries(readings)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    return { ok: failed.length === 0, failed };
  }

  private async wait(ms: number): Promise<void> {
    let remaining = ms;
    const step = 50;
    while (remaining > 0 && !this.disposed && !this.failed) {
      await this.waitUntilVisible();
      if (this.disposed || this.failed) {
        return;
      }
      const currentWait = Math.min(remaining, step);
      await new Promise<void>((resolve) => {
        this.pendingWaitResolvers.push(resolve);
        const timer = window.setTimeout(() => {
          const index = this.pendingWaitResolvers.indexOf(resolve);
          if (index !== -1) {
            this.pendingWaitResolvers.splice(index, 1);
          }
          resolve();
        }, currentWait);
        this.activeTimers.push(timer);
      });
      if (typeof document === 'undefined' || !document.hidden) {
        remaining -= currentWait;
      }
    }
  }

  private async checkFrozenSeam(targetState: RevealState): Promise<void> {
    if (this.frozenState === targetState && !this.disposed && !this.failed) {
      await new Promise<void>((resolve) => {
        this.unfreezeResolver = resolve;
      });
    }
  }

  private enterBlackHold(): void {
    this.currentState = 'black-hold';
    this.timestamps.holdStart = performance.now();
    this.setVeilState('black-hold');
    this.options.lobby?.setBlackHold();
  }

  /**
   * Draws an initial committed black frame and then two additional real scheduled scene frames.
   * Any tab, viewport, orientation, DPR or visual-viewport disruption changes the generation and
   * causes a complete restart under black rather than permitting a stale frame to escape.
   */
  private async stabilizeBehindBlack(reducedMotion: boolean): Promise<boolean> {
    while (!this.disposed && !this.failed) {
      await this.waitUntilVisible();
      if (this.disposed || this.failed) {
        return false;
      }

      this.enterBlackHold();
      this.recordGeometry();
      const generation = this.restartGeneration;
      this.stableFrames = 0;
      this.options.wakeRenderer();

      // This frame occurs after black-hold was applied, so it commits the opaque black veil before
      // any later transparency change can expose the scene.
      await this.options.onFrameRequest();
      if (generation !== this.restartGeneration || this.geometryChanged() || document.hidden) {
        this.requestRestabilization();
        continue;
      }

      while (this.stableFrames < 2 && !this.disposed && !this.failed) {
        this.options.wakeRenderer();
        await this.options.onFrameRequest();
        if (generation !== this.restartGeneration || this.geometryChanged() || document.hidden) {
          this.requestRestabilization();
          break;
        }
        this.stableFrames += 1;
      }
      if (generation !== this.restartGeneration || this.stableFrames < 2) {
        continue;
      }

      if (!reducedMotion) {
        await this.wait(BLACK_HOLD_MIN_MS);
      }
      if (generation !== this.restartGeneration || this.geometryChanged() || document.hidden) {
        this.requestRestabilization();
        continue;
      }

      const predicateCheck = this.areAllPredicatesSatisfied();
      if (!predicateCheck.ok) {
        throw new Error(`Readiness lost during black-hold handshake: ${predicateCheck.failed.join(', ')}`);
      }

      this.timestamps.holdEnd = performance.now();
      await this.checkFrozenSeam('black-hold');
      if (generation !== this.restartGeneration || this.geometryChanged() || document.hidden) {
        this.requestRestabilization();
        continue;
      }
      return true;
    }
    return false;
  }

  /**
   * Sequences: ready-hidden -> cover-to-black -> black-hold -> revealing -> revealed.
   * A disruption at any point cancels the in-flight phase and restarts the stable-frame handshake
   * beneath an opaque black DOM veil.
   */
  public async execute(): Promise<void> {
    if (this.disposed || this.failed) {
      return;
    }

    const reducedMotion = isReducedMotion();
    try {
      this.currentState = 'ready-hidden';
      this.timestamps.readyHidden = performance.now();
      this.setVeilState('ready-hidden');
      this.options.lobby?.prepareForReveal();

      await this.waitUntilVisible();
      if (this.disposed || this.failed) {
        return;
      }

      const initialCheck = this.areAllPredicatesSatisfied();
      if (!initialCheck.ok) {
        throw new Error(`Initial readiness predicates not fulfilled: ${initialCheck.failed.join(', ')}`);
      }

      await this.checkFrozenSeam('ready-hidden');
      if (this.disposed || this.failed) {
        return;
      }

      const readyGeneration = this.restartGeneration;
      if (!reducedMotion) {
        await this.wait(READY_HIDDEN_HOLD_MS);
      }

      if (readyGeneration === this.restartGeneration && !document.hidden) {
        this.currentState = 'cover-to-black';
        this.timestamps.coverStart = performance.now();
        this.setVeilState('cover-to-black');
        this.options.lobby?.setCoverToBlack();
        if (!reducedMotion) {
          await this.wait(COVER_TO_BLACK_MS);
        }
        this.timestamps.coverEnd = performance.now();
        await this.checkFrozenSeam('cover-to-black');
      }

      while (!this.disposed && !this.failed) {
        const stabilized = await this.stabilizeBehindBlack(reducedMotion);
        if (!stabilized || this.disposed || this.failed) {
          return;
        }

        const revealGeneration = this.restartGeneration;
        // The guarded E2E capture freezes the animation at a tokenized partial sample before it
        // can advance while the test harness observes the new DOM state. Production never sets
        // this attribute, so its CSS animation and timing are unchanged.
        if (this.frozenState === 'revealing') {
          this.veilElement.dataset.e2eFreeze = 'revealing';
        }
        this.currentState = 'revealing';
        this.timestamps.revealStart = performance.now();
        this.setVeilState('revealing');
        this.options.lobby?.setRevealing();
        this.options.onRevealing?.();
        // The guarded E2E seam stops at the beginning of the CSS fade, so a deterministic
        // mid-reveal capture observes a genuinely partial veil rather than a completed fade.
        // With no freeze configured this is an immediate no-op and production timing is unchanged.
        await this.checkFrozenSeam('revealing');
        if (!reducedMotion) {
          await this.wait(REVEAL_MS);
        }
        this.timestamps.revealEnd = performance.now();

        if (revealGeneration !== this.restartGeneration || this.geometryChanged() || document.hidden) {
          this.requestRestabilization();
          continue;
        }

        this.currentState = 'revealed';
        this.setVeilState('revealed');
        this.veilElement.hidden = true;
        this.veilElement.style.display = 'none';
        this.options.lobby?.setRevealed();
        this.options.onRevealed?.();
        this.dispose();
        return;
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : String(error));
    }
  }

  private stopAsyncWork(): void {
    for (const timer of this.activeTimers) {
      window.clearTimeout(timer);
    }
    this.activeTimers = [];
    this.abortController.abort();
    const unfreeze = this.unfreezeResolver;
    this.unfreezeResolver = null;
    unfreeze?.();
    const visible = this.visibilityResolver;
    this.visibilityResolver = null;
    visible?.();
    for (const resolve of this.pendingWaitResolvers) {
      resolve();
    }
    this.pendingWaitResolvers = [];
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopAsyncWork();
  }
}
