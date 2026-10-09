/** Exact description corrections, scoped to catalogue look ids after plain-text normalization. */
export const DESCRIPTION_CORRECTIONS = [
  {
    lookId: 'blue-silk-dress',
    source: 'Carrie Lane Chatman Catt',
    replacement: 'Carrie Lane Chapman Catt',
  },
];

/** Apply only a look's declared corrections; changed exports must not silently keep stale entries. */
export function correctDescription(lookId, description) {
  let corrected = description;
  for (const correction of DESCRIPTION_CORRECTIONS) {
    if (correction.lookId !== lookId) continue;
    if (!corrected.includes(correction.source)) {
      throw new Error(
        `Description correction for look "${lookId}" expected text: "${correction.source}"`,
      );
    }
    corrected = corrected.replaceAll(correction.source, correction.replacement);
  }
  return corrected;
}
