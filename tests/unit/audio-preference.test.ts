import { describe, expect, it, vi } from 'vitest';

import {
  MUSIC_STORAGE_KEY,
  resolveMusicPreference,
  storeMusicPreference,
  trackIdFromUrl,
} from '../../src/audio/preference';
import type { KeyValueStore } from '../../src/audio/preference';

/** A store that always answers one value for the music key, like localStorage with a saved choice. */
function storeWith(value: string | null): KeyValueStore {
  return {
    getItem: (key) => (key === MUSIC_STORAGE_KEY ? value : null),
    setItem: () => undefined,
  };
}

/** A store that throws on every read, like localStorage in some private modes. */
function throwingStore(): KeyValueStore {
  return {
    getItem: () => {
      throw new Error('refused');
    },
    setItem: () => {
      throw new Error('refused');
    },
  };
}

describe('resolveMusicPreference', () => {
  it.each([
    { search: '?music=on', stored: 'off', want: 'on' },
    { search: '?music=off', stored: 'on', want: 'off' },
    { search: 'music=off', stored: null, want: 'off' },
    { search: '?music=banana', stored: 'off', want: 'off' },
    { search: '?music=', stored: 'on', want: 'on' },
    { search: '?look=alpha', stored: 'on', want: 'on' },
    { search: '?music=banana', stored: 'also-wrong', want: 'on' },
    { search: '', stored: 'on', want: 'on' },
    { search: '', stored: 'off', want: 'off' },
    { search: '', stored: null, want: 'on' },
    { search: '', stored: 'anything-else', want: 'on' },
  ])(
    'search "$search" over stored "$stored" gives "$want"',
    ({ search, stored, want }) => {
      expect(resolveMusicPreference(search, storeWith(stored))).toBe(want);
    },
  );

  it('skips a store that throws and falls to the default', () => {
    expect(resolveMusicPreference('', throwingStore())).toBe('on');
  });

  it('never reads the store when the URL already decided', () => {
    const store = throwingStore();
    expect(resolveMusicPreference('?music=off', store)).toBe('off');
  });

  it('reads nothing when there is no store', () => {
    expect(resolveMusicPreference('', null)).toBe('on');
    expect(resolveMusicPreference('?music=off', null)).toBe('off');
  });
});

describe('storeMusicPreference', () => {
  it('writes the value under the music key', () => {
    const setItem = vi.fn();
    const store: KeyValueStore = { getItem: () => null, setItem };
    storeMusicPreference(store, 'off');
    expect(setItem).toHaveBeenCalledWith(MUSIC_STORAGE_KEY, 'off');
    expect(MUSIC_STORAGE_KEY).toBe('fashion-rotunda.music');
  });

  it('ignores a store that refuses the write', () => {
    expect(() => storeMusicPreference(throwingStore(), 'on')).not.toThrow();
  });

  it('ignores a missing store', () => {
    expect(() => storeMusicPreference(null, 'on')).not.toThrow();
  });
});

describe('trackIdFromUrl', () => {
  it('reads the id from ?track=', () => {
    expect(trackIdFromUrl('?track=music-03')).toBe('music-03');
    expect(trackIdFromUrl('?look=alpha&track=music-07')).toBe('music-07');
  });

  it('gives null without a track and for an empty value', () => {
    expect(trackIdFromUrl('')).toBeNull();
    expect(trackIdFromUrl('?look=alpha')).toBeNull();
    expect(trackIdFromUrl('?track=')).toBeNull();
  });
});
