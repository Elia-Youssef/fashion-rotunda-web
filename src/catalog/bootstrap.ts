import { contentUrl, loadCatalog } from './catalog';
import type { Catalog, CatalogLook } from './catalog';

/** The two content sets. The half set is the phone build, written by the optimize pass. */
export const FULL_CONTENT_BASE = '/content';
const HALF_CONTENT_BASE = '/content/half';

/**
 * The half set does not exist until the optimize pass writes it, and a phone must still get a
 * page. A failed fetch of the half catalogue is therefore a warning and a fall back to the full
 * set, not a dead screen.
 */
export async function loadContentSet(wantHalf: boolean): Promise<{ base: string; catalog: Catalog }> {
  if (wantHalf) {
    try {
      const catalog = await loadCatalog(contentUrl(HALF_CONTENT_BASE, 'catalog.json'));
      return { base: HALF_CONTENT_BASE, catalog };
    } catch (error) {
      console.warn(
        `[archviz] no content set at ${HALF_CONTENT_BASE}, using ${FULL_CONTENT_BASE}`,
        error,
      );
    }
  }
  const catalog = await loadCatalog(contentUrl(FULL_CONTENT_BASE, 'catalog.json'));
  return { base: FULL_CONTENT_BASE, catalog };
}

/** `?look=<id>`, falling back to the first look in the catalogue with one warning. */
export function chooseLook(catalog: Catalog, params: URLSearchParams): CatalogLook {
  const first = catalog.looks[0];
  const wanted = params.get('look');
  if (wanted === null) {
    return first;
  }
  const found = catalog.looks.find((look) => look.id === wanted);
  if (found === undefined) {
    console.warn(`[archviz] no look "${wanted}" in the catalogue, showing "${first.id}"`);
    return first;
  }
  return found;
}

/** `?variant=<name>`, falling back to the look's own default with one warning. */
export function chooseVariant(look: CatalogLook, params: URLSearchParams): string {
  const wanted = params.get('variant');
  if (wanted === null) {
    return look.defaultVariant;
  }
  if (!look.variants.includes(wanted)) {
    console.warn(
      `[archviz] the look "${look.id}" has no variant "${wanted}", showing "${look.defaultVariant}"`,
    );
    return look.defaultVariant;
  }
  return wanted;
}

/**
 * The switch order for the e2e memory check: every step is a real change of look and the last
 * one returns to where the run started, so the two readings of renderer.info.memory compare the
 * same scene with itself.
 */
export function switchOrder(ids: string[], startId: string, count: number): string[] {
  const others = ids.filter((id) => id !== startId);
  if (count < 1 || others.length === 0) {
    return [];
  }
  const order: string[] = [];
  for (let step = 0; step < count - 1; step += 1) {
    order.push(others[step % others.length]);
  }
  order.push(startId);
  return order;
}

