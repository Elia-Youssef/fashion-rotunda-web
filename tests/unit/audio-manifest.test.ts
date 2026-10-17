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

/** The manifest with tracks[0] carrying the given field values over the base ones. */
function withTrack(fields: Record<string, unknown>): FixtureManifest {
  const copy = base();
  copy.tracks[0] = { ...copy.tracks[0], ...fields };
  return copy;
}

/** The manifest with tracks[0].sources[0] carrying the given field values over the base ones. */
function withSource(fields: Record<string, unknown>): FixtureManifest {
  const copy = base();
  copy.tracks[0].sources[0] = { ...copy.tracks[0].sources[0], ...fields };
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
    expect(() => parseMusicManifest({ ...base(), tracks: 'none' })).toThrow(
      /tracks is not an array/,
    );
    expect(() => parseMusicManifest({ ...base(), default: 5 })).toThrow(/default is not a string/);
  });

  it('rejects a present but wrongly typed sources list', () => {
    expect(() => parseMusicManifest(withTrack({ sources: 'nope' }))).toThrow(
      /tracks\[0\]\.sources is not an array/,
    );
  });

  it('rejects wrongly typed track fields, not just missing ones', () => {
    expect(() => parseMusicManifest(withTrack({ id: 42 }))).toThrow(/tracks\[0\]\.id is not a string/);
    expect(() => parseMusicManifest(withTrack({ title: 7 }))).toThrow(
      /tracks\[0\]\.title is not a string/,
    );
    expect(() => parseMusicManifest(withTrack({ duration: '105.65' }))).toThrow(
      /tracks\[0\]\.duration is not a number/,
    );
  });

  it('rejects wrongly typed source fields, not just missing ones', () => {
    expect(() => parseMusicManifest(withSource({ url: 1 }))).toThrow(
      /tracks\[0\]\.sources\[0\]\.url is not a string/,
    );
    expect(() => parseMusicManifest(withSource({ type: 2 }))).toThrow(
      /tracks\[0\]\.sources\[0\]\.type is not a string/,
    );
    expect(() => parseMusicManifest(withSource({ bytes: '1241641' }))).toThrow(
      /tracks\[0\]\.sources\[0\]\.bytes is not a number/,
    );
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

  it('says "is not an object" for a null entry and a null source', () => {
    // typeof null is "object", so the null slips past a plain typeof check and must still be
    // caught with the same message a non-object value gets.
    expect(() => parseMusicManifest({ ...base(), tracks: [null] })).toThrow(
      /tracks\[0\] is not an object/,
    );
    expect(() => parseMusicManifest(withTrack({ sources: [null] }))).toThrow(
      /tracks\[0\]\.sources\[0\] is not an object/,
    );
  });
});
