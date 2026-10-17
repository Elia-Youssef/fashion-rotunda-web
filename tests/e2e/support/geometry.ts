/** One axis-aligned box in CSS pixels, the shape Playwright's boundingBox() reports. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** True when the two boxes overlap; boxes that only share an edge or a corner do not count. */
export function boxesIntersect(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}
