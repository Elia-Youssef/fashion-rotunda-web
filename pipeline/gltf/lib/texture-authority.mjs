// Installs the PNGs exported beside a look as the authoritative versions of Unreal-named textures.
//
// The Unreal glTF exporter sometimes embeds a black or otherwise placeholder image under the right
// texture name. A slot-level repair alone cannot fix that: a correct normal slot, for example,
// would retain the placeholder. This helper deliberately keys only on an exact source texture name;
// exporter-baked textures with another name remain untouched.

/**
 * Replaces every already-present texture whose exact name has a canonical source image.
 *
 * `loadSource(name)` must return the PNG bytes for `name`. It is deliberately injected so this
 * module stays independently testable and does not know about the pipeline filesystem layout.
 * Returns a name map for the follow-up repair pass and the names whose embedded payload changed.
 */
export function canonicalizeSourceTextures(document, sourceNames, loadSource) {
  const available = sourceNames instanceof Set ? sourceNames : new Set(sourceNames ?? []);
  const byName = new Map();
  const canonicalized = [];

  // Do not construct the map first: malformed exports may contain duplicate names, and every
  // duplicate bearing an authoritative name needs its placeholder payload replaced.
  for (const texture of document.getRoot().listTextures()) {
    const name = texture.getName();
    if (available.has(name)) {
      texture.setMimeType('image/png').setImage(asPngBytes(loadSource(name), name));
      canonicalized.push(name);
    }
    byName.set(name, texture);
  }
  return { byName, canonicalized };
}

/**
 * Gets an authoritative texture by exact name, creating it from the canonical PNG when the
 * exporter omitted the texture object altogether. Existing entries are assumed to have passed
 * through canonicalizeSourceTextures(), so they already contain canonical bytes.
 */
export function getOrCreateSourceTexture(document, byName, name, loadSource) {
  const existing = byName.get(name);
  if (existing) return { texture: existing, created: false };

  const texture = document
    .createTexture(name)
    .setMimeType('image/png')
    .setImage(asPngBytes(loadSource(name), name));
  byName.set(name, texture);
  return { texture, created: true };
}

function asPngBytes(bytes, name) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error(`Canonical texture ${name} did not provide PNG bytes.`);
  }
  return bytes;
}
