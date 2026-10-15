// The music player: fetch the manifest, fetch the chosen file, decode it once, then loop it on an
// AudioBufferSourceNode with fades between every state. An AudioBufferSourceNode plays once, so
// every start builds a new node at the remembered offset while the decoded buffer lives for the
// page; a media element's loop has an audible gap in some browsers, a buffer loop is
// sample-accurate. Races are settled by a generation counter, the same idea as the look switcher:
// only the newest request may start a source, and an old source's onended never changes the state.

import type { AudioBuses, AudioEngine } from './engine';
import { loopPosition } from './loop-math';
import { pickSource } from './sources';

export type MusicState = 'off' | 'armed' | 'loading' | 'playing' | 'error';

export interface TrackSource {
  url: string;
  type: string;
  bytes: number;
}

export interface MusicTrack {
  id: string;
  title: string;
  duration: number;
  sources: TrackSource[];
}

export interface MusicManifest {
  version: number;
  default: string;
  tracks: MusicTrack[];
}

/** Narrowing guard for values that came off a JSON parse; an array still fails the field checks. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Throws with a message naming the field when the JSON is not a manifest. */
export function parseMusicManifest(json: unknown): MusicManifest {
  if (!isRecord(json)) {
    throw new Error('music manifest: the manifest is not an object');
  }
  if (typeof json['version'] !== 'number') {
    throw new Error('music manifest: version is not a number');
  }
  if (typeof json['default'] !== 'string') {
    throw new Error('music manifest: default is not a string');
  }
  if (!Array.isArray(json['tracks'])) {
    throw new Error('music manifest: tracks is not an array');
  }
  const tracks = json['tracks'].map((entry, index): MusicTrack => {
    const where = `music manifest: tracks[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${where} is not an object`);
    }
    if (typeof entry['id'] !== 'string') {
      throw new Error(`${where}.id is not a string`);
    }
    if (typeof entry['title'] !== 'string') {
      throw new Error(`${where}.title is not a string`);
    }
    if (typeof entry['duration'] !== 'number') {
      throw new Error(`${where}.duration is not a number`);
    }
    if (!Array.isArray(entry['sources'])) {
      throw new Error(`${where}.sources is not an array`);
    }
    const sources = entry['sources'].map((one, sourceIndex): TrackSource => {
      const sourceWhere = `${where}.sources[${sourceIndex}]`;
      if (!isRecord(one)) {
        throw new Error(`${sourceWhere} is not an object`);
      }
      if (typeof one['url'] !== 'string') {
        throw new Error(`${sourceWhere}.url is not a string`);
      }
      if (typeof one['type'] !== 'string') {
        throw new Error(`${sourceWhere}.type is not a string`);
      }
      if (typeof one['bytes'] !== 'number') {
        throw new Error(`${sourceWhere}.bytes is not a number`);
      }
      return { url: one['url'], type: one['type'], bytes: one['bytes'] };
    });
    return { id: entry['id'], title: entry['title'], duration: entry['duration'], sources };
  });
  return { version: json['version'], default: json['default'], tracks };
}

export interface MusicPlayerOptions {
  engine: AudioEngine;
  /** Where music.json and the files live: '/content/music'. */
  baseUrl: string;
  /** The track to play; null means the manifest's default. An unknown id warns once and uses the default. */
  trackId: string | null;
  /** The loop's level on its bus, 0 to 1. */
  level: number;
  /** Ramp length for start and stop, milliseconds. */
  fadeMs: number;
  onStateChange: (state: MusicState, detail: string | null) => void;
}

export interface MusicPlayer {
  readonly state: MusicState;
  /** Seconds into the loop, 0 before the first start; frozen while off. */
  readonly position: number;
  /** Asks for music. Inside a gesture it fetches, decodes and starts; before any gesture it arms. */
  play(): Promise<void>;
  /** Fades out over fadeMs, stops, keeps the position and the decoded buffer. */
  pause(): Promise<void>;
  /**
   * playing, loading or armed: pause. off or error: play. An armed switch already reads "Music
   * on", so a press on it asks for the music that was going to start to stop.
   */
  toggle(): Promise<void>;
  dispose(): void;
}

/**
 * Whether a gesture has happened on the page. userActivation is typed in lib.dom but absent at
 * runtime in older browsers; when it is missing the caller lets unlock() try, because only the
 * browser's own answer can say whether the context may run.
 */
function hasBeenActive(): boolean {
  if (!('userActivation' in navigator)) {
    return true;
  }
  return navigator.userActivation.hasBeenActive;
}

export function createMusicPlayer(options: MusicPlayerOptions): MusicPlayer {
  const { engine, baseUrl, trackId, level, fadeMs, onStateChange } = options;

  let playerState: MusicState = 'off';
  let generation = 0;
  let controller: AbortController | null = null;
  let manifest: MusicManifest | null = null;
  let manifestPromise: Promise<MusicManifest> | null = null;
  let warnedUnknownTrack = false;
  let buffer: AudioBuffer | null = null;
  let bufferedTrackId: string | null = null;
  let buses: AudioBuses | null = null;
  let source: AudioBufferSourceNode | null = null;
  let sourceGain: GainNode | null = null;
  let loopDuration: number | null = null;
  /** Seconds into the loop: the offset the next source starts from, and the reading while off. */
  let position = 0;
  let startedAt = 0;

  function setState(state: MusicState, detail: string | null): void {
    playerState = state;
    onStateChange(state, detail);
  }

  /** Pin the current gain value, then ramp to the target over fadeMs. */
  function rampGain(gain: GainNode, context: AudioContext, to: number): void {
    const now = context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(to, now + fadeMs / 1000);
  }

  /** Fetch options with the abort signal only while a load owns the controller. */
  function requestOptions(): RequestInit {
    return controller === null ? {} : { signal: controller.signal };
  }

  async function loadManifest(): Promise<MusicManifest> {
    if (manifest !== null) {
      return manifest;
    }
    if (manifestPromise === null) {
      const fetchJson = (async (): Promise<MusicManifest> => {
        const response = await fetch(`${baseUrl}/music.json`, requestOptions());
        if (!response.ok) {
          throw new Error(`The music list could not be fetched (status ${response.status}).`);
        }
        manifest = parseMusicManifest(await response.json());
        return manifest;
      })();
      // A failed fetch must not be remembered: the next play() retries from the failed step.
      manifestPromise = fetchJson.catch((error: unknown) => {
        manifestPromise = null;
        throw error;
      });
    }
    return manifestPromise;
  }

  function chooseTrack(listed: MusicManifest): MusicTrack {
    if (trackId !== null) {
      const wanted = listed.tracks.find((entry) => entry.id === trackId);
      if (wanted !== undefined) {
        return wanted;
      }
      if (!warnedUnknownTrack) {
        console.warn(`[archviz] no music track "${trackId}", playing "${listed.default}"`);
        warnedUnknownTrack = true;
      }
    }
    const fallback = listed.tracks.find((entry) => entry.id === listed.default);
    const chosen = fallback ?? listed.tracks[0];
    if (chosen === undefined) {
      throw new Error('The music list has no track to play.');
    }
    return chosen;
  }

  async function ensureTrack(): Promise<{ track: MusicTrack; audioBuses: AudioBuses }> {
    const listed = await loadManifest();
    const track = chooseTrack(listed);
    if (buses === null) {
      throw new Error('The audio context is not available.');
    }
    if (buffer === null || bufferedTrackId !== track.id) {
      // canPlayType is the one allowed use of a media element: choosing the file format.
      const picked = pickSource(track.sources, (type) => new Audio().canPlayType(type));
      if (picked === null) {
        throw new Error('This browser plays neither music format.');
      }
      const response = await fetch(`${baseUrl}/${picked.url}`, requestOptions());
      if (!response.ok) {
        throw new Error(`The music file could not be fetched (status ${response.status}).`);
      }
      const data = await response.arrayBuffer();
      // decodeAudioData detaches the buffer, so it is never reused after this line.
      buffer = await buses.context.decodeAudioData(data);
      bufferedTrackId = track.id;
    }
    return { track, audioBuses: buses };
  }

  function startSource(track: MusicTrack, audioBuses: AudioBuses): void {
    if (buffer === null) {
      throw new Error('The music buffer is missing.');
    }
    const context = audioBuses.context;
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.loopStart = 0;
    // loopEnd comes from the manifest, not from the decoded buffer, so a decoder that pads the
    // end of the file never plays that padding once per loop.
    node.loopEnd = track.duration;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, context.currentTime);
    gain.gain.linearRampToValueAtTime(level, context.currentTime + fadeMs / 1000);
    node.connect(gain);
    gain.connect(audioBuses.music);
    node.start(0, position);
    // onended fires on stop() too; it only ever cleans this node up, the state is owned elsewhere.
    node.onended = () => {
      node.disconnect();
      gain.disconnect();
    };
    source = node;
    sourceGain = gain;
    startedAt = context.currentTime;
    loopDuration = track.duration;
  }

  // play and pause are closures, not methods: toggle calls them by name, so a `const { toggle } =
  // player` handed to a listener cannot lose its receiver and throw.
  async function play(): Promise<void> {
    if (playerState === 'playing' || playerState === 'loading') {
      return;
    }
    if (!hasBeenActive()) {
      // No context is created before a gesture, so Chrome's "not allowed to start" line never
      // appears; the switch shows armed until the visitor touches the page.
      setState('armed', null);
      return;
    }
    const mine = (generation += 1);
    controller = new AbortController();
    setState('loading', null);
    try {
      const unlocked = await engine.unlock();
      if (mine !== generation) {
        return;
      }
      if (unlocked === null) {
        if (!('userActivation' in navigator)) {
          // Without userActivation the browser, not the visitor, may be the reason: arm, do not
          // call this an error.
          setState('armed', null);
          return;
        }
        throw new Error('The audio context would not start.');
      }
      buses = unlocked;
      const { track, audioBuses } = await ensureTrack();
      if (mine !== generation) {
        return;
      }
      startSource(track, audioBuses);
      setState('playing', null);
    } catch (error: unknown) {
      if (mine !== generation) {
        return;
      }
      // The visitor-facing text is the switch's business: the raw cause goes to the console
      // with the same [archviz] prefix as the unknown-track warning, and the state carries no
      // detail for the switch to echo.
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[archviz] music unavailable: ${reason}`);
      setState('error', null);
    } finally {
      if (mine === generation) {
        controller = null;
      }
    }
  }

  async function pause(): Promise<void> {
    if (playerState === 'off') {
      return;
    }
    // Retires any load in flight; its own run notices through the generation counter.
    generation += 1;
    if (controller !== null) {
      controller.abort();
      controller = null;
    }
    const node = source;
    const gain = sourceGain;
    const context = buses?.context ?? null;
    if (node !== null && gain !== null && context !== null && loopDuration !== null) {
      position = loopPosition(startedAt, position, context.currentTime, loopDuration);
      const now = context.currentTime;
      rampGain(gain, context, 0);
      node.stop(now + fadeMs / 1000);
    }
    source = null;
    sourceGain = null;
    // Off at once: the visitor pressed stop, the fade is presentation.
    setState('off', null);
  }

  return {
    get state(): MusicState {
      return playerState;
    },

    get position(): number {
      const context = buses?.context ?? null;
      if (source === null || context === null || loopDuration === null) {
        return position;
      }
      return loopPosition(startedAt, position, context.currentTime, loopDuration);
    },

    play,

    pause,

    async toggle(): Promise<void> {
      // armed counts as playing here: the switch reads "Music on" while armed, so a press on it
      // means the visitor does not want the music that was going to start.
      if (playerState === 'playing' || playerState === 'loading' || playerState === 'armed') {
        await pause();
        return;
      }
      await play();
    },

    dispose(): void {
      generation += 1;
      if (controller !== null) {
        controller.abort();
        controller = null;
      }
      if (source !== null) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // A source that never started throws on stop; it is finished either way.
        }
        source.disconnect();
        sourceGain?.disconnect();
        source = null;
        sourceGain = null;
      }
    },
  };
}
