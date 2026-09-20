// Goal G6.5: the loading gate's arithmetic, kept free of the DOM and of three.js so the numbers
// are testable in node. The gate owns the reading of Resource Timing; this module owns what the
// readings mean.

export interface ManifestFile {
  bytes: number;
}

/** The two files every first frame needs, whatever look opens the room. Manifest key names. */
const STATIC_FILES = ['rotunda.glb', 'plinth.glb'];

/**
 * The bytes the first frame needs: rotunda, plinth, the first look's file, from the manifest set.
 * A missing entry counts 0: the total is advisory for the readout, never a reason to fail boot.
 */
export function expectedBytes(files: Record<string, ManifestFile>, firstLookFile: string): number {
  let total = 0;
  for (const name of [...STATIC_FILES, firstLookFile]) {
    total += files[name]?.bytes ?? 0;
  }
  return total;
}

export interface ResourceEntry {
  name: string;
  transferSize: number;
  responseEnd: number;
}

/**
 * Whether an entry's URL lives under the content base. Resource Timing reports absolute URLs in
 * the page while the unit tests pass relative paths, so both forms are accepted; a malformed name
 * matches nothing.
 */
export function underContentBase(name: string, contentBase: string): boolean {
  const prefix = `${contentBase}/`;
  if (name.startsWith(prefix)) {
    return true;
  }
  try {
    return new URL(name).pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

/**
 * The bytes received so far under the content base, from Resource Timing entries; cache hits
 * count 0 because transferSize is 0 for them, which is the honest reading rather than a defect.
 */
export function receivedBytes(entries: ResourceEntry[], contentBase: string): number {
  let total = 0;
  for (const entry of entries) {
    if (underContentBase(entry.name, contentBase)) {
      total += entry.transferSize;
    }
  }
  return total;
}

/** 0 to 1, clamped; expected 0 means 1, because a readout with no denominator is done, not empty. */
export function progressRatio(received: number, expected: number): number {
  if (expected <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, received / expected));
}

/**
 * "4.2 MB of 10.9 MB", one decimal, in MB (1,000,000 bytes). The clamp is for the minus sign:
 * toFixed(-0.05) is "-0.0", and a readout must never tell the visitor it has negative bytes.
 */
export function formatProgress(received: number, expected: number): string {
  const inMB = (bytes: number): string => (Math.max(0, bytes) / 1_000_000).toFixed(1);
  return `${inMB(received)} MB of ${inMB(expected)} MB`;
}
