// A selective rebuild changes one look and its two manifest entries. Shared files, catalog
// settings, thumbnails and all unrelated entries retain their existing bytes and values.
import { totalsOf } from './manifest.mjs';

export function selectLook(plan, id) {
  const selected = plan.filter((item) => item.look?.id === id);
  if (selected.length !== 1) throw new Error(`Select exactly one known look: ${id}`);
  return selected;
}

export function updateSelectedManifest(before, file, entries, errors) {
  if (!before.sets.full.files[file] || !before.sets.half.files[file]) {
    throw new Error(`Selected rebuild requires existing full and half entries for ${file}`);
  }
  if (errors.some((error) => error.file !== file)) throw new Error('Unrelated texture error in selected rebuild');
  const next = structuredClone(before);
  for (const set of ['full', 'half']) {
    next.sets[set].files[file] = entries[set];
    next.sets[set].totals = totalsOf(next.sets[set].files);
  }
  next.errors = [...before.errors.filter((error) => error.file !== file), ...errors];
  return next;
}

export function updateSelectedCatalog(before, candidate, id) {
  const look = candidate.looks.find((entry) => entry.id === id);
  if (!look || before.looks.filter((entry) => entry.id === id).length !== 1) {
    throw new Error(`Selected rebuild requires one existing catalogue entry for ${id}`);
  }
  return { ...before, looks: before.looks.map((entry) => entry.id === id ? look : entry) };
}
