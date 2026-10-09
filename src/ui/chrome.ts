// The chrome module: the one place that binds the catalogue strip and the product card to the
// page. It owns no DOM of its own; it owns the rules; which look is busy, what a swatch click does
// to the showroom, what order Reset runs in, and that every action ends with onChange so the loop
// draws the frame the visitor just asked for.

import './chrome.css';

import { contentUrl } from '../catalog/catalog';
import type { Catalog, CatalogLook } from '../catalog/catalog';
import { mountCatalogStrip } from './catalog-strip';
import { mountProductCard } from './product-card';

export interface ChromeOptions {
  catalog: Catalog;
  contentBase: string;
  stripRoot: HTMLElement;
  cardRoot: HTMLElement;
  showroom: {
    showLook(id: string): Promise<void>;
    setVariant(name: string): Promise<void>;
    setLookYaw(radians: number): void;
    readonly currentLook: string | null;
    readonly currentVariant: string | null;
  };
  /** Toggles the turntable and returns its new state; the hook passes it. */
  onRotateToggle: () => boolean;
  /** The hook passes it; a no-op is acceptable when no camera control is mounted. */
  onResetCamera: () => void;
  /** Fired after every change, so the loop can invalidate. */
  onChange: () => void;
}

export interface ChromeHandle {
  /** Re-reads the showroom, for a look changed from outside the chrome (the ?look= boot path). */
  refresh(): void;
  dispose(): void;
}

export function mountChrome(options: ChromeOptions): ChromeHandle {
  const { catalog, showroom } = options;

  /** A look without a thumbnail is an empty string, never a URL the caller would have to check. */
  function thumbnailUrl(look: CatalogLook): string {
    return look.thumbnail === null ? '' : contentUrl(options.contentBase, look.thumbnail);
  }

  function lookById(id: string | null): CatalogLook | null {
    if (id === null) {
      return null;
    }
    return catalog.looks.find((look) => look.id === id) ?? null;
  }

  /** Look switches in flight. Busy is one slot in the handle, so it clears with the last settle. */
  let pendingSwitches = 0;

  /**
   * Variant changes share one ordered queue. A swatch can still be resolving when Reset is pressed;
   * issuing both calls concurrently lets the earlier swatch finish last and silently undo Reset.
   * Chaining every mutation preserves the visitor's intent order, so the last requested operation
   * is also the last operation applied by the showroom.
   */
  let variantMutations: Promise<void> = Promise.resolve();

  function mutateVariant(name: string): Promise<void> {
    const mutation = variantMutations.then(() => showroom.setVariant(name));
    // Keep the queue usable after a rejected content mutation while returning the real result to
    // the caller so it can report the specific failed swatch or Reset.
    variantMutations = mutation.catch(() => undefined);
    return mutation;
  }

  function syncToCurrent(): void {
    const id = showroom.currentLook;
    strip.setCurrent(id);
    const look = lookById(id);
    if (look !== null) {
      // The showroom carries the visitor's chosen swatch to the new look, so the variant is read
      // back from it rather than assumed to be the look's default.
      card.setLook(look, showroom.currentVariant);
    }
  }

  function selectLook(id: string): void {
    pendingSwitches += 1;
    strip.setBusy(id);
    // Promise.resolve().then keeps a synchronous throw from showLook inside the chain: the strip
    // still settles, clears its busy mark and follows whatever look is on screen.
    void Promise.resolve()
      .then(() => showroom.showLook(id))
      .catch((error: unknown) => {
        // The switcher keeps the previous look on screen; the sync below follows it.
        console.warn(`[archviz] the look "${id}" did not load`, error);
      })
      .then(() => {
        pendingSwitches -= 1;
        if (pendingSwitches === 0) {
          strip.setBusy(null);
        }
        // A superseded switch resolves too: currentLook is the winner, whichever click won.
        syncToCurrent();
        options.onChange();
      });
  }

  /** Applies a swatch, then marks what the showroom actually took, not what was asked for. */
  async function applyVariant(name: string): Promise<void> {
    try {
      await mutateVariant(name);
    } catch (error) {
      // A variant the look file does not carry is a content defect worth seeing, not a dead page.
      console.warn(`[archviz] the look would not take the variant "${name}"`, error);
    }
    card.setVariant(showroom.currentVariant);
    options.onChange();
  }

  async function applyReset(look: CatalogLook): Promise<void> {
    showroom.setLookYaw(0);
    try {
      await mutateVariant(look.defaultVariant);
    } catch (error) {
      console.warn(`[archviz] the look "${look.id}" would not take its default variant`, error);
    }
    options.onResetCamera();
    // Reset stops the turntable along with the camera, so the Rotate button must not keep
    // reading pressed for a wheel that no longer turns.
    card.setRotating(false);
    card.setVariant(showroom.currentVariant);
    options.onChange();
  }

  const card = mountProductCard(options.cardRoot, {
    look: lookById(showroom.currentLook),
    variant: showroom.currentVariant,
    thumbnailUrl,
    actions: {
      rotate(): void {
        card.setRotating(options.onRotateToggle());
        options.onChange();
      },
      reset(): void {
        const look = lookById(showroom.currentLook);
        if (look === null) {
          return;
        }
        void applyReset(look);
      },
      material(name: string): void {
        void applyVariant(name);
      },
    },
  });

  const strip = mountCatalogStrip(options.stripRoot, {
    looks: catalog.looks,
    thumbnailUrl,
    current: showroom.currentLook,
    onSelect: selectLook,
  });

  return {
    refresh(): void {
      syncToCurrent();
    },
    dispose(): void {
      strip.dispose();
      card.dispose();
    },
  };
}
