import { describe, expect, it } from 'vitest';

import { parseMusicManifest } from '../../src/audio/manifest';

// The fixture is typed rather than asserted: an index signature makes every field readable,
// writable and deletable by name, and naming tracks and sources as lists of the same shape lets
// the omission helpers walk down to a source without one type assertion.
interface FixtureSource {
  [field: string]: unknown;
}
interface FixtureTrack {
  [field: string]: unknown;
  sources: FixtureSource[];
}
interface FixtureManifest {
  [field: string]: unknown;
  tracks: FixtureTrack[];
}

/** A fresh manifest per test, so the omission helpers never see a mutated copy. */
function base(): FixtureManifest {
  return {
    version: 1,
    default: 'music-01',
    tracks: [
      {
        id: 'music-01',
        title: 'Track 1',
        duration: 105.65,
        sources: [
          { url: 'music-01.ogg', type: 'audio/ogg; codecs="opus"', bytes: 1241641 },
          { url: 'music-01.m4a', type: 'audio/mp4; codecs="mp4a.40.2"', bytes: 1715446 },
        ],
      },
    ],
  };
}

/** The manifest with one top-level field removed, the shape a bad pipeline run could write. */
function withoutTop(key: string): FixtureManifest {
  const copy = base();
  delete copy[key];
  return copy;
}

/** The manifest with one field of tracks[0] removed. */
function withoutTrack(key: string): FixtureManifest {
  const copy = base();
  delete copy.tracks[0][key];
  return copy;
}

/** The manifest with one field of tracks[0].sources[0] removed. */
function withoutSource(key: string): FixtureManifest {
  const copy = base();
  delete copy.tracks[0].sources[0][key];
  return copy;
}

describe('parseMusicManifest', () => {
  it('parses a full manifest into the same values', () => {
    const manifest = parseMusicManifest(base());
    expect(manifest.version).toBe(1);
    expect(manifest.default).toBe('music-01');
    expect(manifest.tracks).toHaveLength(1);
    expect(manifest.tracks[0]).toEqual({
      id: 'music-01',
      title: 'Track 1',
      duration: 105.65,
      sources: [
        { url: 'music-01.ogg', type: 'audio/ogg; codecs="opus"', bytes: 1241641 },
        { url: 'music-01.m4a', type: 'audio/mp4; codecs="mp4a.40.2"', bytes: 1715446 },
      ],
    });
  });

  it('rejects a non-object', () => {
    expect(() => parseMusicManifest(null)).toThrow(/music manifest/);
    expect(() => parseMusicManifest('music')).toThrow(/not an object/);
    expect(() => parseMusicManifest(3)).toThrow(/not an object/);
  });

  it.each(['version', 'default', 'tracks'])('names the missing top-level field %s', (key) => {
    expect(() => parseMusicManifest(withoutTop(key))).toThrow(new RegExp(key));
  });

  it('rejects a wrong type by field name', () => {
    const copy = base();
    copy.version = 'one';
    expect(() => parseMusicManifest(copy)).toThrow(/version/);
    // Spread rather than assigned: tracks is a list in the fixture's type, and the wrong type is
    // the point of the test.
    expect(() => parseMusicManifest({ ...base(), tracks: 'none' })).toThrow(/tracks/);
  });

  it.each(['id', 'title', 'duration', 'sources'])('names the missing track field %s', (key) => {
    expect(() => parseMusicManifest(withoutTrack(key))).toThrow(new RegExp(key));
  });

  it.each(['url', 'type', 'bytes'])('names the missing source field %s', (key) => {
    expect(() => parseMusicManifest(withoutSource(key))).toThrow(new RegExp(key));
  });

  it('names the track by index when the entry is not an object', () => {
    expect(() => parseMusicManifest({ ...base(), tracks: ['nope'] })).toThrow(/tracks\[0\]/);
  });

  it('says "is not an object" for a non-object entry, track and source alike', () => {
    // A field-type message also names tracks[0], so the index alone cannot tell these apart; a
    // caller reading the message needs to know the entry itself was the problem.
    expect(() => parseMusicManifest({ ...base(), tracks: ['nope'] })).toThrow(
      /tracks\[0\] is not an object/,
    );
    expect(() =>
      parseMusicManifest({ ...base(), tracks: [{ ...base().tracks[0], sources: ['nope'] }] }),
    ).toThrow(/tracks\[0\]\.sources\[0\] is not an object/);
  });
});
