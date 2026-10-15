// Builds manifest.json from per-file inspections.
//
// The shape is fixed by the manifest data contract: two sets, a files map per set keyed by
// the path the page requests, and totals per set. Three fields are added beyond that shape, all
// additive and all needed by a caller the contract already names:
//
//   drawCalls              per file, the node-to-primitive pairs one frame submits. The budget
//                          table has a draw-call row and nothing else can answer it offline.
//   largestTexture         per file, and largestNonFloorTexture beside it, so the "largest texture"
//                          budget rows measure the shipped files instead of trusting the cap rule.
//                          `floor` on each texture is what separates the two, and records why a
//                          texture was allowed the wider cap.
//   errors                 at the root, one entry per texture the encoder refused. The run
//                          continues past a failed texture, so the failure has to be recorded
//                          in the manifest for callers to inspect.

import { gpuBytes } from './budget.mjs';

/** The sets the manifest always carries, in order, even when one of them is empty. */
export const SET_NAMES = ['full', 'half'];

/**
 * One texture entry, with gpuBytes derived rather than passed: the formula lives in budget.mjs and
 * is used here so the manifest and the budget table can never disagree.
 */
export function textureEntry({ name, width, height, format, colorSpace, bytes, floor = false }) {
  return {
    name,
    width,
    height,
    format,
    colorSpace,
    bytes,
    gpuBytes: gpuBytes(width, height, format),
    floor,
  };
}

/** One file entry. `textures` are textureEntry results; gpuBytes is their sum. */
export function fileEntry({ bytes, triangles, meshes, nodes, materials, drawCalls, textures }) {
  const list = textures ?? [];
  return {
    bytes,
    triangles,
    meshes,
    nodes,
    materials,
    drawCalls,
    textures: list,
    gpuBytes: list.reduce((total, texture) => total + texture.gpuBytes, 0),
    largestTexture: list.reduce((best, texture) => Math.max(best, texture.width, texture.height), 0),
    largestNonFloorTexture: list
      .filter((texture) => !texture.floor)
      .reduce((best, texture) => Math.max(best, texture.width, texture.height), 0),
  };
}

/** Sums one set's files. */
export function totalsOf(files) {
  const entries = Object.values(files);
  return {
    bytes: entries.reduce((total, file) => total + file.bytes, 0),
    gpuBytes: entries.reduce((total, file) => total + file.gpuBytes, 0),
    triangles: entries.reduce((total, file) => total + file.triangles, 0),
  };
}

/**
 * Assembles the manifest.
 *
 * @param generated an ISO 8601 timestamp. The only field allowed to differ between two runs.
 * @param sets `{ full: { 'rotunda.glb': fileEntry, ... }, half: { ... } }`.
 * @param errors texture failures, `{ set, file, texture, message }`.
 */
export function buildManifest(generated, sets, errors = []) {
  const out = { generated, sets: {}, errors };
  for (const name of SET_NAMES) {
    const files = sets[name] ?? {};
    out.sets[name] = { files: sortedByKey(files), totals: totalsOf(files) };
  }
  return out;
}

/**
 * The text of a shipped JSON file: two-space indented with a final newline, and every character
 * outside printable ASCII except the newline written as a backslash-u escape, so the file stays ASCII
 * while its parsed value is unchanged. Catalogue descriptions come from the Unreal data and can carry
 * typographic dashes.
 */
export function shippedJson(value) {
  const text = JSON.stringify(value, null, 2).replace(
    /[^\n\x20-\x7e]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
  return `${text}\n`;
}

/** Key order is part of byte-identical output, so the files map is always sorted. */
function sortedByKey(files) {
  const sorted = {};
  for (const key of Object.keys(files).sort()) sorted[key] = files[key];
  return sorted;
}
