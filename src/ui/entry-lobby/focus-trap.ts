export function bindFocusTrap(
  doc: Document,
  lobby: HTMLElement,
  signal: AbortSignal,
  isDisposed: () => boolean,
): void {
  // Keyboard accessibility: focus trapping & Tab containment
  doc.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if (isDisposed()) {
        return;
      }
      if (event.key === 'Escape') {
        // Escape must NOT dismiss the lobby into an unloaded scene
        event.preventDefault();
        return;
      }

      if (event.key === 'Tab') {
        const focusables = Array.from(
          lobby.querySelectorAll<HTMLElement>(
            'button:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => el.offsetParent !== null || el === doc.activeElement);

        if (focusables.length === 0) {
          event.preventDefault();
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (event.shiftKey && doc.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && doc.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (!focusables.includes(doc.activeElement as HTMLElement)) {
          event.preventDefault();
          first.focus();
        }
      }
    },
    { signal },
  );
}

export function focusInitially(
  doc: Document,
  lobby: HTMLElement,
  loadBtn: HTMLButtonElement | null,
  isHydrating: boolean,
): void {
  // Set initial focus intentionally
  if (!isHydrating || doc.activeElement === doc.body || doc.activeElement === null) {
    lobby.tabIndex = -1;
    if (loadBtn && !loadBtn.disabled) {
      loadBtn.focus();
    } else {
      lobby.focus();
    }
  }
}
