// The music preference: where the page learns whether the visitor wants music, and in which order
// those sources win. Pure module on purpose: the store is passed in, because reading
// window.localStorage can itself throw in some private modes and the caller decides what that means
// for the page.

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const MUSIC_STORAGE_KEY = 'fashion-rotunda.music';

export type MusicPreference = 'on' | 'off';

/**
 * `?music=on|off` wins, then the stored value, then 'on'. A value that is neither 'on' nor 'off'
 * falls to the next source, and a store whose getItem throws is ignored the same way: both mean
 * "this source has nothing to say" rather than "the visitor wants music".
 */
export function resolveMusicPreference(search: string, store: KeyValueStore | null): MusicPreference {
  const fromUrl = new URLSearchParams(search).get('music');
  if (fromUrl === 'on' || fromUrl === 'off') {
    return fromUrl;
  }
  if (store !== null) {
    let stored: string | null;
    try {
      stored = store.getItem(MUSIC_STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (stored === 'on' || stored === 'off') {
      return stored;
    }
  }
  return 'on';
}

/** Writes the value; a store that throws is ignored, since some private modes refuse writes. */
export function storeMusicPreference(store: KeyValueStore | null, value: MusicPreference): void {
  if (store === null) {
    return;
  }
  try {
    store.setItem(MUSIC_STORAGE_KEY, value);
  } catch {
    // The preference then lasts only this page view, which the live switch still honours.
  }
}

/** `?track=<id>`, or null. An empty value is no id, not a request for an unnamed track. */
export function trackIdFromUrl(search: string): string | null {
  const value = new URLSearchParams(search).get('track');
  return value === null || value === '' ? null : value;
}
