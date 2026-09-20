// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Catalog, CatalogLook } from '../../src/catalog/catalog';
import { AUDIO_STUB_MESSAGE, mountChrome } from '../../src/ui/chrome';
import type { ChromeHandle } from '../../src/ui/chrome';

function makeLook(id: string, name: string): CatalogLook {
  return {
    id,
    name,
    description: `${name} description`,
    thumbnail: `thumbs/${id}.jpg`,
    file: `looks/${id}.glb`,
    audio: null,
    variants: ['base', 'light', 'dark'],
    defaultVariant: 'base',
    mannequinNode: 'mannequin',
  };
}

const LOOKS: CatalogLook[] = [
  makeLook('wallis-dress', 'Wallis Dress'),
  makeLook('zoot-suit', 'Zoot Suit'),
  makeLook('new-look-dress', 'New Look Dress'),
];

function makeCatalog(): Catalog {
  return {
    version: 1,
    environment: { file: 'env/school-field-cloudy-1k.hdr' },
    rotunda: { file: 'rotunda.glb' },
    plinth: { file: 'plinth.glb' },
    looks: LOOKS,
    views: { proof: { position: [0, 1.7, 4.2], target: [0, 1, 0], fov: 40 } },
  };
}

/**
 * The showroom as the chrome module sees it, with the real switcher's rules: the latest request
 * wins, earlier ones resolve superseded without touching the screen, and the visitor's chosen
 * swatch is carried to every later look that offers it. The calls array is the shared log the
 * ordering assertions read; every method and the camera hook record into it.
 */
function fakeShowroom(initialLook: string) {
  let currentLook: string | null = initialLook;
  let currentVariant: string | null = 'base';
  let wantedVariant: string | null = null;
  const calls: string[] = [];
  /** Look switches started but not settled. */
  const pending: Array<(won: boolean) => void> = [];

  function variantFor(id: string): string | null {
    const look = LOOKS.find((candidate) => candidate.id === id);
    if (look === undefined) {
      return null;
    }
    if (wantedVariant !== null && look.variants.includes(wantedVariant)) {
      return wantedVariant;
    }
    return look.defaultVariant;
  }

  return {
    calls,
    /** Settles the race the way the real switcher does: the latest request wins. */
    settleNextSwitch(): void {
      const winner = pending.pop();
      if (winner === undefined) {
        throw new Error('no switch to settle');
      }
      for (const superseded of pending.splice(0)) {
        superseded(false);
      }
      winner(true);
    },
    /** The outside world (the ?look= boot path) moving the showroom under the chrome. */
    setExternally(id: string, variant: string | null): void {
      currentLook = id;
      currentVariant = variant;
    },
    showLook: vi.fn((id: string): Promise<void> => {
      calls.push(`showLook:${id}`);
      return new Promise<void>((resolve) => {
        pending.push((won: boolean) => {
          if (won) {
            currentLook = id;
            currentVariant = variantFor(id);
          }
          resolve();
        });
      });
    }),
    setVariant: vi.fn((name: string): Promise<void> => {
      calls.push(`setVariant:${name}`);
      wantedVariant = name;
      currentVariant = name;
      return Promise.resolve();
    }),
    setLookYaw: vi.fn((radians: number): void => {
      calls.push(`setLookYaw:${radians}`);
    }),
    get currentLook(): string | null {
      return currentLook;
    },
    get currentVariant(): string | null {
      return currentVariant;
    },
  };
}

type FakeShowroom = ReturnType<typeof fakeShowroom>;

let stripRoot: HTMLElement;
let cardRoot: HTMLElement;
let chrome: ChromeHandle | null = null;

beforeEach(() => {
  stripRoot = document.createElement('nav');
  cardRoot = document.createElement('aside');
  document.body.append(stripRoot, cardRoot);
});

afterEach(() => {
  chrome?.dispose();
  chrome = null;
  stripRoot.remove();
  cardRoot.remove();
});

interface MountOverrides {
  showroom?: FakeShowroom;
  initialLook?: string;
  onRotateToggle?: () => boolean;
  onChange?: () => void;
}

function mount(overrides: MountOverrides = {}): { handle: ChromeHandle; showroom: FakeShowroom } {
  const showroom = overrides.showroom ?? fakeShowroom(overrides.initialLook ?? LOOKS[0].id);
  const onRotateToggle = overrides.onRotateToggle ?? vi.fn((): boolean => true);
  const onResetCamera = vi.fn((): void => {
    showroom.calls.push('resetCamera');
  });
  const onChange = overrides.onChange ?? vi.fn();
  chrome = mountChrome({
    catalog: makeCatalog(),
    contentBase: '/content',
    stripRoot,
    cardRoot,
    showroom,
    onRotateToggle,
    onResetCamera,
    onChange,
  });
  return { handle: chrome, showroom };
}

function stripButton(id: string): HTMLButtonElement {
  const found = stripRoot.querySelector<HTMLButtonElement>(`button[data-look="${id}"]`);
  if (!found) throw new Error(`no strip button for ${id}`);
  return found;
}

function cardText(selector: string): string {
  return cardRoot.querySelector(selector)?.textContent ?? '';
}

function swatch(variant: string): HTMLButtonElement {
  const found = cardRoot.querySelector<HTMLButtonElement>(
    `.product-card__swatch[aria-label="${variant}"]`,
  );
  if (!found) throw new Error(`no swatch for ${variant}`);
  return found;
}

function actionButton(label: string): HTMLButtonElement {
  const found = [...cardRoot.querySelectorAll<HTMLButtonElement>('.product-card__action')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

describe('mountChrome', () => {
  it('mounts the strip from the catalogue and the card from the showroom', () => {
    mount();
    expect(stripRoot.querySelectorAll('button')).toHaveLength(3);
    expect(stripButton('wallis-dress').getAttribute('aria-current')).toBe('true');
    expect(cardText('.product-card h2')).toBe('Wallis Dress');
  });

  it('lands the card above what the panel already held', () => {
    const badge = document.createElement('div');
    cardRoot.appendChild(badge);
    mount();
    expect(cardRoot.firstElementChild?.classList.contains('product-card')).toBe(true);
  });

  it('carries the Audio action as a disabled button with the stub sentence ready', () => {
    mount();
    const audio = [...cardRoot.querySelectorAll<HTMLButtonElement>('.product-card__action')].find(
      (candidate) => candidate.textContent === 'Audio',
    );
    expect(audio?.disabled).toBe(true);
    expect(AUDIO_STUB_MESSAGE).toBe("audio arrives with G5.1's audio step");
  });
});

describe('selecting a look', () => {
  it('shows busy on the chosen item, then follows the showroom when it settles', async () => {
    const onChange = vi.fn();
    const { showroom } = mount({ onChange });
    stripButton('zoot-suit').click();
    expect(stripButton('zoot-suit').getAttribute('aria-busy')).toBe('true');
    // showLook starts in a microtask (a synchronous throw must stay inside the chain), so the
    // test waits for the request to exist before settling it.
    await vi.waitFor(() => {
      expect(showroom.showLook).toHaveBeenCalledWith('zoot-suit');
    });
    showroom.settleNextSwitch();
    await vi.waitFor(() => {
      expect(cardText('.product-card h2')).toBe('Zoot Suit');
    });
    expect(stripButton('zoot-suit').getAttribute('aria-current')).toBe('true');
    expect(stripButton('zoot-suit').hasAttribute('aria-busy')).toBe(false);
    expect(onChange).toHaveBeenCalled();
  });

  it('ends on the winner when a second click lands before the first settles', async () => {
    const { showroom } = mount();
    stripButton('zoot-suit').click();
    stripButton('new-look-dress').click();
    await vi.waitFor(() => {
      expect(showroom.showLook).toHaveBeenCalledTimes(2);
    });
    showroom.settleNextSwitch();
    await vi.waitFor(() => {
      expect(cardText('.product-card h2')).toBe('New Look Dress');
    });
    expect(stripButton('new-look-dress').getAttribute('aria-current')).toBe('true');
    expect(stripRoot.querySelectorAll('[aria-busy]')).toHaveLength(0);
  });

  it('keeps the visitor swatch through a switch, reading it back from the showroom', async () => {
    const { showroom } = mount();
    swatch('dark').click();
    await vi.waitFor(() => {
      expect(swatch('dark').getAttribute('aria-checked')).toBe('true');
    });
    stripButton('zoot-suit').click();
    await vi.waitFor(() => {
      expect(showroom.showLook).toHaveBeenCalledWith('zoot-suit');
    });
    showroom.settleNextSwitch();
    await vi.waitFor(() => {
      expect(cardText('.product-card h2')).toBe('Zoot Suit');
    });
    expect(swatch('dark').getAttribute('aria-checked')).toBe('true');
  });
});

describe('the swatches', () => {
  it('send the click to the showroom and mark what it took', async () => {
    const { showroom } = mount();
    swatch('dark').click();
    expect(showroom.setVariant).toHaveBeenCalledWith('dark');
    await vi.waitFor(() => {
      expect(swatch('dark').getAttribute('aria-checked')).toBe('true');
    });
    expect(swatch('base').getAttribute('aria-checked')).toBe('false');
  });

  it('mark the showroom answer, not the request, when a variant is refused', async () => {
    const refusing = fakeShowroom('wallis-dress');
    refusing.setVariant.mockImplementation((name: string): Promise<void> => {
      refusing.calls.push(`setVariant:${name}`);
      return Promise.reject(new Error(`the look has no variant "${name}"`));
    });
    const { showroom } = mount({ showroom: refusing });
    swatch('dark').click();
    await vi.waitFor(() => {
      expect(showroom.setVariant).toHaveBeenCalledWith('dark');
    });
    // The refusal leaves the check where the showroom says it is: on base.
    await vi.waitFor(() => {
      expect(swatch('base').getAttribute('aria-checked')).toBe('true');
    });
    expect(swatch('dark').getAttribute('aria-checked')).toBe('false');
  });
});

describe('Reset', () => {
  it('calls yaw, variant, camera, in that order, and ends with the default swatch', async () => {
    const { showroom } = mount();
    swatch('dark').click();
    await vi.waitFor(() => {
      expect(swatch('dark').getAttribute('aria-checked')).toBe('true');
    });
    actionButton('Reset').click();
    await vi.waitFor(() => {
      expect(showroom.calls).toContain('resetCamera');
    });
    expect(showroom.calls.slice(-3)).toEqual(['setLookYaw:0', 'setVariant:base', 'resetCamera']);
    expect(swatch('base').getAttribute('aria-checked')).toBe('true');
  });

  it('releases a pressed Rotate button: the camera reset stops the turntable too', async () => {
    const onRotateToggle = vi.fn((): boolean => true);
    const { showroom } = mount({ onRotateToggle });
    actionButton('Rotate').click();
    expect(actionButton('Rotate').getAttribute('aria-pressed')).toBe('true');
    actionButton('Reset').click();
    await vi.waitFor(() => {
      expect(showroom.calls).toContain('resetCamera');
    });
    expect(actionButton('Rotate').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('Rotate', () => {
  it('toggles through the hook and presses the button from the returned state', () => {
    const onRotateToggle = vi.fn((): boolean => true);
    mount({ onRotateToggle });
    actionButton('Rotate').click();
    expect(onRotateToggle).toHaveBeenCalledTimes(1);
    expect(actionButton('Rotate').getAttribute('aria-pressed')).toBe('true');
  });

  it('releases the button when the hook reports the turntable off', () => {
    const onRotateToggle = vi.fn((): boolean => false);
    mount({ onRotateToggle });
    actionButton('Rotate').click();
    expect(actionButton('Rotate').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('ChromeHandle.refresh', () => {
  it('follows a look changed from outside the chrome', () => {
    const { handle, showroom } = mount();
    showroom.setExternally('new-look-dress', 'light');
    handle.refresh();
    expect(cardText('.product-card h2')).toBe('New Look Dress');
    expect(stripButton('new-look-dress').getAttribute('aria-current')).toBe('true');
    expect(swatch('light').getAttribute('aria-checked')).toBe('true');
  });
});

describe('ChromeHandle.dispose', () => {
  it('empties both roots', () => {
    const badge = document.createElement('div');
    cardRoot.appendChild(badge);
    const { handle } = mount();
    handle.dispose();
    chrome = null;
    expect(stripRoot.childElementCount).toBe(0);
    expect(cardRoot.childElementCount).toBe(1);
    expect(cardRoot.firstElementChild).toBe(badge);
  });
});
