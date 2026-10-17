// Pure state parsing and search string serialization for deep links.
// Holds no DOM references and no three.js objects so it runs under node tests.

import { DEFAULT_RIG, SERIALIZED_DECIMALS, serializeRig } from '../lighting/rig';

export interface ShareState {
  look: string | null;
  variant: string | null;
  /** serializeRig output, or null for the level's own rig. */
  rig: string | null;
  /** Orbit position and optional target height in metres; null means the proof pose. */
  camera: [number, number, number, number?] | null;
  /** Turntable yaw in radians, three decimals; null means zero. */
  yaw: number | null;
  turning: boolean;
  music: 'on' | 'off' | null;
  post: string | null;
}

/** The parameter names this module owns, in order. */
export const SHARE_PARAMS: readonly string[] = [
  'look',
  'variant',
  'rig',
  'cam',
  'yaw',
  'turn',
  'music',
  'post',
] as const;

/**
 * The level's own rig as the URL would spell it. Exported because the mount compares the live rig
 * against it on every write, and two copies of the same computation can drift apart.
 */
export const DEFAULT_RIG_SERIALIZED = serializeRig(DEFAULT_RIG);

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Owned values are encoded on the way out, because parsing decodes: a look id carrying a space or
 * an ampersand would otherwise split the pair and read back as something else. The comma and the
 * semicolon are put back afterwards. Both are legal in a query (RFC 3986 sub-delims) and
 * URLSearchParams reads them as themselves, while the camera triple and the rig are made of them,
 * so encoding those two would treble the length of a shared link for no gain.
 */
function encodeValue(value: string): string {
  return encodeURIComponent(value).replace(/%2C/g, ',').replace(/%3B/g, ';');
}

function isValidRigString(raw: string): boolean {
  if (raw.startsWith('v2;')) {
    const parts = raw.split(';').slice(1);
    if (parts.length === 0) return false;
    return parts.every((part) => {
      const id = part.split(',')[0];
      return id === 'key' || id === 'fill' || id === 'back' || id === 'day' || id === 'e';
    });
  }
  if (raw.startsWith('v1;')) {
    const parts = raw.split(';').slice(1);
    if (parts.length === 0) return false;
    return parts.every((part) => {
      const id = part.split(',')[0];
      return (
        id === 'top' ||
        id === 'indirect' ||
        id === 'key' ||
        id === 'fill' ||
        id === 'back' ||
        id === 'sun' ||
        id === 'sky' ||
        id === 'e'
      );
    });
  }
  return false;
}

/** Reads the state from a search string; unknown or malformed values read as null. */
export function parseShareState(search: string): ShareState {
  const clean = search.startsWith('?') ? search.slice(1) : search;
  if (clean.length === 0) {
    return {
      look: null,
      variant: null,
      rig: null,
      camera: null,
      yaw: null,
      turning: false,
      music: null,
      post: null,
    };
  }

  const params = new URLSearchParams(clean);

  const rawLook = params.get('look');
  const look = rawLook !== null && rawLook.trim().length > 0 ? rawLook : null;

  const rawVariant = params.get('variant');
  const variant = rawVariant !== null && rawVariant.trim().length > 0 ? rawVariant : null;

  const rawRig = params.get('rig');
  const rig = rawRig !== null && isValidRigString(rawRig) ? rawRig : null;

  let camera: ShareState['camera'] = null;
  const rawCam = params.get('cam');
  if (rawCam !== null) {
    const parts = rawCam.split(',');
    if ((parts.length === 3 || parts.length === 4) && parts.every((part) => part.trim() !== '')) {
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      const z = Number(parts[2]);
      const height = parts.length === 4 ? Number(parts[3]) : undefined;
      if ([x, y, z].every(Number.isFinite) && (height === undefined || Number.isFinite(height))) {
        camera = [
          round(x, SERIALIZED_DECIMALS), round(y, SERIALIZED_DECIMALS), round(z, SERIALIZED_DECIMALS),
        ];
        if (height !== undefined) camera.push(round(height, SERIALIZED_DECIMALS));
      }
    }
  }

  let yaw: number | null = null;
  const rawYaw = params.get('yaw');
  if (rawYaw !== null) {
    const parsedYaw = Number(rawYaw);
    if (Number.isFinite(parsedYaw)) {
      const roundedYaw = round(parsedYaw, SERIALIZED_DECIMALS);
      yaw = roundedYaw === 0 ? null : roundedYaw;
    }
  }

  const turning = params.get('turn') === '1';

  let music: 'on' | 'off' | null = null;
  const rawMusic = params.get('music');
  if (rawMusic === 'on' || rawMusic === 'off') {
    music = rawMusic;
  }

  let post: string | null = null;
  const rawPost = params.get('post');
  if (rawPost === 'off' || rawPost === 'ao' || rawPost === 'aa') {
    post = rawPost;
  }

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

/** Serializes an owned property value to string or null if omitted/default. */
function serializeOwned(key: string, state: ShareState): string | null {
  switch (key) {
    case 'look':
      return state.look !== null && state.look.trim().length > 0 ? state.look : null;
    case 'variant':
      return state.variant !== null && state.variant.trim().length > 0 ? state.variant : null;
    case 'rig':
      return state.rig !== null && state.rig !== DEFAULT_RIG_SERIALIZED ? state.rig : null;
    case 'cam':
      if (state.camera === null) return null;
      return state.camera
        .filter((n): n is number => n !== undefined)
        .map((n) => round(n, SERIALIZED_DECIMALS).toFixed(SERIALIZED_DECIMALS)).join(',');
    case 'yaw':
      return state.yaw !== null && round(state.yaw, SERIALIZED_DECIMALS) !== 0
        ? round(state.yaw, SERIALIZED_DECIMALS).toFixed(SERIALIZED_DECIMALS)
        : null;
    case 'turn':
      return state.turning ? '1' : null;
    case 'music':
      return state.music === 'off' ? 'off' : null;
    case 'post':
      return state.post === 'off' || state.post === 'ao' || state.post === 'aa' ? state.post : null;
    default:
      return null;
  }
}

/**
 * Writes the state into a search string, keeping every parameter this module does not own
 * (webgl, tier, e2e, proof, track, gate) as it was, and omitting a parameter whose value is null,
 * false or the default, so a fresh page has a bare URL.
 */
export function buildSearch(current: string, state: ShareState): string {
  const clean = current.startsWith('?') ? current.slice(1) : current;
  const rawEntries = clean.length === 0 ? [] : clean.split('&');

  const ownedMap = new Map<string, string | null>();
  for (const name of SHARE_PARAMS) {
    ownedMap.set(name, serializeOwned(name, state));
  }

  const resultPairs: string[] = [];
  const handledOwned = new Set<string>();

  for (const entry of rawEntries) {
    if (entry.length === 0) {
      continue;
    }
    const equalsIndex = entry.indexOf('=');
    const key = equalsIndex === -1 ? entry : entry.slice(0, equalsIndex);

    if (ownedMap.has(key)) {
      if (!handledOwned.has(key)) {
        handledOwned.add(key);
        const val = ownedMap.get(key) ?? null;
        if (val !== null) {
          resultPairs.push(`${key}=${encodeValue(val)}`);
        }
      }
    } else {
      // Foreign parameter preserved exactly in place
      resultPairs.push(entry);
    }
  }

  // Append any newly present owned parameters in SHARE_PARAMS order
  for (const name of SHARE_PARAMS) {
    if (!handledOwned.has(name)) {
      const val = ownedMap.get(name) ?? null;
      if (val !== null) {
        resultPairs.push(`${name}=${encodeValue(val)}`);
      }
    }
  }

  return resultPairs.length === 0 ? '' : `?${resultPairs.join('&')}`;
}
