// The one call the hook in main.ts makes: creates the engine, the player and the switch, and wires
// them to the page. The preference decides the start: 'on' arms the music and listens for the
// first gesture anywhere on the page, 'off' fetches nothing and listens for nothing. The gesture
// listeners come and go with the armed state rather than being installed once, because the music
// can return to armed long after the boot: an interrupted context is the case that matters.

import { mountMusicSwitch } from '../ui/music-switch';
import type { MusicSwitchHandle } from '../ui/music-switch';
import { createAudioEngine } from './engine';
import type { AudioEngine } from './engine';
import { createMusicPlayer } from './music';
import type { MusicPlayer, MusicState } from './music';
import { resolveMusicPreference, storeMusicPreference, trackIdFromUrl } from './preference';
import type { KeyValueStore } from './preference';

export interface MusicMountOptions {
  headerRoot: HTMLElement;
  search: string;
  /** '/content/music' */
  baseUrl: string;
  /**
   * When true, audio fetch and playback are deferred until startDeferred() is called,
   * keeping the critical first-frame scene loading free from audio bandwidth competition.
   */
  deferPlay?: boolean;
  /** Optional pre-created engine (e.g. unlocked during user gesture). */
  engine?: AudioEngine;
}

export interface MusicMount {
  engine: AudioEngine;
  player: MusicPlayer;
  startDeferred(): Promise<void>;
  dispose(): void;
}

declare global {
  interface Window {
    /** Test-only handle, mounted in dev and behind ?e2e=1; the e2e suite reads the position through it. */
    archvizMusic?: {
      state(): MusicState;
      position(): number;
    };
  }
}

/** The localStorage property access itself can throw in some private modes; null then means none. */
function readStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The switch's own selector: a gesture that lands inside it is the switch's to answer, not ours. */
const SWITCH_SELECTOR = '.music-switch';

export function mountMusic(options: MusicMountOptions): MusicMount {
  const engine = options.engine ?? createAudioEngine();
  const store = readStore();
  const preference = resolveMusicPreference(options.search, store);

  // One controller per installation, so the pair can go and come back: null means not listening.
  let gestures: AbortController | null = null;
  let switchHandle: MusicSwitchHandle | null = null;
  /** Set once the context has actually run, so a first suspended reading is not read as a loss. */
  let contextRan = false;

  function stopListeningForGesture(): void {
    gestures?.abort();
    gestures = null;
  }

  const player = createMusicPlayer({
    engine,
    baseUrl: options.baseUrl,
    trackId: trackIdFromUrl(options.search),
    level: 0.5,
    fadeMs: 400,
    onStateChange: (state, detail) => {
      switchHandle?.setState(state, detail);
      if (state === 'armed') {
        // Armed at boot, or armed again after a context that will not run: either way the next
        // gesture anywhere on the page is what starts the music.
        listenForGesture();
      } else if (state === 'off') {
        // Off while armed means the visitor declined the music that was going to start; the
        // gesture listeners have no job left. After a played pause they are already gone.
        stopListeningForGesture();
      }
    },
  });

  /** Idempotent: called at boot, on every armed state, and by the interruption recovery. */
  function listenForGesture(): void {
    if (gestures !== null) {
      return;
    }
    const controller = new AbortController();
    gestures = controller;
    const onFirstGesture = (event: Event): void => {
      // A press on the switch is the switch's own business: its click decides what the press
      // means, and answering the capture-phase pointerdown here would start a fetch that the
      // click that follows immediately aborts.
      if (event.target instanceof Element && event.target.closest(SWITCH_SELECTOR) !== null) {
        return;
      }
      // Both listeners go together; the second gesture needs no listener, the state is already
      // the player's business.
      stopListeningForGesture();
      void player.play();
    };
    // Capture, so a handler that stops propagation cannot hide the gesture from the music.
    window.addEventListener('pointerdown', onFirstGesture, {
      capture: true,
      signal: controller.signal,
    });
    window.addEventListener('keydown', onFirstGesture, {
      capture: true,
      signal: controller.signal,
    });
  }

  switchHandle = mountMusicSwitch(options.headerRoot, {
    state: player.state,
    onToggle: () => {
      const before = player.state;
      void player.toggle();
      storeMusicPreference(store, before === 'off' || before === 'error' ? 'on' : 'off');
    },
  });

  // iOS reports 'interrupted' after a phone call and a browser may suspend a context it considers
  // idle. The source keeps running on paper while nothing reaches the speakers, so without this
  // the switch would go on reading "Music on" over silence. Stop for real, then ask again: the
  // ask cannot start a context outside a gesture, so it lands on armed where the browser says so
  // and on error where it refuses, and both leave the next gesture able to bring the loop back at
  // the position it kept.
  const releaseEngineWatch = engine.onStateChange((state) => {
    if (state === 'running') {
      contextRan = true;
      return;
    }
    if (!contextRan || (state !== 'interrupted' && state !== 'suspended')) {
      return;
    }
    if (player.state !== 'playing' && player.state !== 'loading') {
      return;
    }
    void (async () => {
      await player.pause();
      await player.play();
      if (player.state !== 'playing') {
        listenForGesture();
      }
    })();
  });

  if (preference === 'on') {
    if (options.deferPlay) {
      switchHandle?.setState('armed', 'Starts when experience is ready');
    } else {
      listenForGesture();
      // Arms until the first gesture; no context exists yet and nothing is fetched.
      void player.play();
    }
  }

  let exposed = false;
  if (import.meta.env.DEV || new URLSearchParams(options.search).get('e2e') === '1') {
    window.archvizMusic = {
      state: () => player.state,
      position: () => player.position,
    };
    exposed = true;
  }

  return {
    engine,
    player,
    async startDeferred(): Promise<void> {
      if (preference === 'on' && player.state !== 'playing' && player.state !== 'loading') {
        await player.play();
      }
    },
    dispose(): void {
      stopListeningForGesture();
      releaseEngineWatch();
      switchHandle?.dispose();
      switchHandle = null;
      player.dispose();
      engine.dispose();
      if (exposed) {
        delete window.archvizMusic;
      }
    },
  };
}
