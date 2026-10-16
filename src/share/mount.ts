// Composition hook: binds share state to URL, mounts UI, and handles actions.
// Observes canvas attributes, camera motion, turntable, lighting and music, writing back via
// history.replaceState (at most 4 Hz) and restoring camera, yaw and turning at boot.

import { MUSIC_STORAGE_KEY, resolveMusicPreference } from '../audio/preference';
import type { KeyValueStore, MusicPreference } from '../audio/preference';
import type { Rig } from '../lighting/rig';
import { lazyImport } from '../ui/lazy-import';
import { mountShare as mountShareUI } from '../ui/share';
import type { ScreenshotOptions } from './screenshot';
import { buildSearch, parseShareState } from './state';
import type { ShareState } from './state';

export interface ShareMountOptions {
  root: HTMLElement;
  search: string;
  showroom: {
    readonly currentLook: string | null;
    readonly currentVariant: string | null;
    showLook(id: string): Promise<void>;
    setVariant(name: string): Promise<void>;
    readonly lookYaw: number;
  };
  /** The look the page shows with no `?look=`: the first in the catalogue. */
  defaultLook: string;
  /** The swatch that look carries with no `?variant=`: its own defaultVariant. */
  defaultVariant: string;
  lighting: { readonly rig: Rig; apply(rig: Rig): void; serialize(): string };
  camera: {
    orbit: {
      readonly position: [number, number, number];
      moveTo(position: [number, number, number], target: [number, number, number]): void;
    };
    turntable: {
      readonly yaw: number;
      readonly running: boolean;
      setYaw(radians: number): void;
      start(): void;
      stop(): void;
    };
  };
  music: { readonly player: { readonly state: string } };
  postFeatures: () => string;
  proofTarget: [number, number, number];
  renderer: ScreenshotOptions['renderer'];
  canvas: HTMLCanvasElement;
  drawFrame: () => void;
  onChange: () => void;
}

export interface ShareMount {
  dispose(): void;
}

const TAU = 2 * Math.PI;
const THROTTLE_MS = 250;

/** The localStorage property access itself can throw in some private modes; null then means none. */
function readMusicStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatStillFileName(lookId: string, date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const min = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `fashion-rotunda-${lookId}-${yyyy}${mm}${dd}-${hh}${min}${ss}.png`;
}

export function mountShare(options: ShareMountOptions): ShareMount {
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  // Share an in-flight import, and let a failed chunk load be retried by the next action.
  const loadScreenshot = lazyImport(() => import('./screenshot'));
  // Capture proof position before applying any state overrides so proof resets can be detected.
  const proofPos = options.camera.orbit.position;
  const proofPosition: [number, number, number] = [proofPos[0], proofPos[1], proofPos[2]];

  // What the chain drew at boot. data-post names the features it built ("ao,traa"), while ?post=
  // in a link is the share subset off|ao|aa (src/share/state.ts) of the slices src/post/chain.ts
  // reads, so the two compare only as "has this moved since boot": while it has not, the link keeps
  // the ?post= it arrived with, and a page that never overrode post stays bare.
  const bootPostFeatures = options.postFeatures();

  const musicStore = readMusicStore();
  // The player's state is transient: 'armed' is a page still waiting for its first gesture and
  // 'loading' is a track still starting up, and both would read as "on" in a link. The
  // switch writes the visitor's answer to the store on every press (src/audio/mount.ts), so the
  // store is the durable reading; before the first press the player's boot state is what the page
  // is doing, which is what ?music= and the store had already settled in the audio mount.
  const bootMusic: MusicPreference = options.music.player.state === 'off' ? 'off' : 'on';

  // Boot: parse state and apply camera pose, yaw and turntable state that main.ts has not applied.
  const bootState = parseShareState(options.search);

  if (bootState.camera !== null) {
    // moveTo, not setPose: setPose re-homes the orbit, which would point the card's Reset at the
    // shared pose instead of the proof view the page was built with.
    options.camera.orbit.moveTo(bootState.camera, options.proofTarget);
  }
  if (bootState.yaw !== null) {
    options.camera.turntable.setYaw(bootState.yaw);
  }
  if (bootState.turning) {
    options.camera.turntable.start();
  }

  function readMusicPreference(): MusicPreference {
    if (musicStore === null) {
      return bootMusic;
    }
    let stored: string | null;
    try {
      stored = musicStore.getItem(MUSIC_STORAGE_KEY);
    } catch {
      // A throwing store says nothing (the policy in src/audio/preference.ts), so the boot default wins.
      return bootMusic;
    }
    // The raw read answers only whether the store has spoken at all, which a silent store and a
    // stored 'on' otherwise share; resolveMusicPreference owns how the value itself is read.
    if (stored !== 'on' && stored !== 'off') {
      return bootMusic;
    }
    return resolveMusicPreference('', musicStore);
  }

  function collectCurrentState(): ShareState {
    const liveLook = options.showroom.currentLook ?? options.canvas.dataset['look'] ?? null;
    const liveVariant = options.showroom.currentVariant ?? options.canvas.dataset['variant'] ?? null;
    // The catalogue's first look and its own swatch are what a bare URL already means, so writing
    // them would hand a visitor who changed nothing a link carrying look= and variant=.
    const look = liveLook === options.defaultLook ? null : liveLook;
    const variant = liveVariant === options.defaultVariant ? null : liveVariant;

    // buildSearch owns omission of the default rig for every serialization caller.
    const rig = options.lighting.serialize();

    const pos = options.camera.orbit.position;
    const dx = pos[0] - proofPosition[0];
    const dy = pos[1] - proofPosition[1];
    const dz = pos[2] - proofPosition[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    const camera: [number, number, number] | null =
      distSq < 0.0001 ? null : [pos[0], pos[1], pos[2]];

    const turning = options.camera.turntable.running;

    // A running turntable moves the yaw every frame, so writing it would mean one replaceState
    // every 250 ms for as long as it runs, and Safari throws above 100 calls in 30 seconds.
    // turn=1 alone restores a turning table, and the angle is written once it stops.
    let yaw: number | null = null;
    if (!turning) {
      let wrappedYaw = options.camera.turntable.yaw % TAU;
      if (wrappedYaw < 0) {
        wrappedYaw += TAU;
      }
      const roundedYaw = Math.round(wrappedYaw * 1000) / 1000;
      yaw = roundedYaw === 0 || roundedYaw === Math.round(TAU * 1000) / 1000 ? null : roundedYaw;
    }

    // 'on' is what the preference answers when nothing has been chosen, so it is the default the
    // URL leaves out.
    const music: 'on' | 'off' | null = readMusicPreference() === 'off' ? 'off' : null;

    const livePost = options.postFeatures();
    const post = livePost === bootPostFeatures ? bootState.post : livePost;

    return {
      look,
      variant,
      rig,
      camera,
      yaw,
      turning,
      music,
      post,
    };
  }

  let lastReplaceTime = 0;
  let pendingTimer: number | null = null;

  function updateSearchNow(): void {
    // Disposal clears the timer sources; keep the write boundary safe for future callers too.
    if (signal.aborted) return;
    if (pendingTimer !== null) {
      window.clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    lastReplaceTime = performance.now();
    const nextState = collectCurrentState();
    const currentSearch = window.location.search;
    const nextSearch = buildSearch(currentSearch, nextState);
    if (nextSearch !== currentSearch) {
      const nextUrl = window.location.pathname + nextSearch + window.location.hash;
      window.history.replaceState(null, '', nextUrl);
    }
  }

  function scheduleUpdate(): void {
    // Scheduling must never extend the mount lifetime, even if another event source is added.
    if (signal.aborted) return;
    const now = performance.now();
    const elapsed = now - lastReplaceTime;

    // An elapsed window publishes in this callback, without waiting for another timer task.
    if (elapsed >= THROTTLE_MS) {
      updateSearchNow();
    } else if (pendingTimer === null) {
      pendingTimer = window.setTimeout(updateSearchNow, THROTTLE_MS - elapsed);
    }
  }

  const uiHandle = mountShareUI(options.root, {
    async copyLink(): Promise<void> {
      if (signal.aborted) return;
      updateSearchNow();
      const href = window.location.href;
      let copied = false;
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        try {
          await navigator.clipboard.writeText(href);
          copied = true;
        } catch {
          copied = false;
        }
      }

      if (signal.aborted) return;
      if (copied) {
        uiHandle.notify('Link copied');
      } else {
        const fallback = options.root.querySelector<HTMLInputElement>('.share__fallback');
        if (fallback !== null) {
          fallback.value = href;
          fallback.classList.remove('share__fallback--hidden');
          fallback.focus();
          fallback.select();
        }
        uiHandle.notify('Press Ctrl+C to copy');
      }
    },

    async screenshot(): Promise<void> {
      if (signal.aborted) return;
      try {
        // Input wakes the frame loop; loading must not let a scaler step change the requested size.
        const requestedPixelRatio = options.renderer.getPixelRatio();
        const { captureStill, deliverStill } = await loadScreenshot();
        if (signal.aborted) return;
        const blob = await captureStill({
          renderer: options.renderer,
          canvas: options.canvas,
          drawFrame: options.drawFrame,
          scale: 2,
          requestedPixelRatio,
        });
        if (signal.aborted) return;
        options.onChange();

        const lookId = options.showroom.currentLook ?? 'look';
        const fileName = formatStillFileName(lookId);
        const result = await deliverStill(blob, fileName, signal);
        // Delivery can outlive disposal. Keep its continuation within the same lifetime even
        // though the current UI handle also ignores notifications after it is disposed.
        if (signal.aborted) return;
        uiHandle.notify(result === 'shared' ? 'Still shared' : 'Still saved');
      } catch (error) {
        if (signal.aborted) return;
        // A press that produces nothing and says nothing reads as a dead button, so the failure
        // is on the status line as well as in the console.
        console.error('[archviz] screenshot capture failed', error);
        uiHandle.notify('Screenshot failed');
      }
    },
  });

  const pollInterval = window.setInterval(() => {
    scheduleUpdate();
  }, THROTTLE_MS);

  const canvasObserver = new MutationObserver(() => {
    scheduleUpdate();
  });
  canvasObserver.observe(options.canvas, {
    attributes: true,
    attributeFilter: ['data-look', 'data-variant', 'data-yaw', 'data-post'],
  });

  let musicObserver: MutationObserver | null = null;
  const musicSwitchBtn = document.querySelector<HTMLElement>('.music-switch');
  if (musicSwitchBtn !== null) {
    musicObserver = new MutationObserver(() => {
      scheduleUpdate();
    });
    musicObserver.observe(musicSwitchBtn, {
      attributes: true,
      attributeFilter: ['data-music'],
    });
  }

  return {
    dispose(): void {
      lifetime.abort();
      window.clearInterval(pollInterval);
      if (pendingTimer !== null) {
        window.clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      canvasObserver.disconnect();
      musicObserver?.disconnect();
      uiHandle.dispose();
    },
  };
}
