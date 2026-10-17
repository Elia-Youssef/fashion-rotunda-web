// The music manifest contract and validation of its track and source fields.

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
