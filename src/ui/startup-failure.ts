// Terminal startup failures and where they become visible. The lobby's error pane with its
// retry button is the surface while the lobby owns the screen; without one, the page body
// carries a plain DOM notice with the same job. The first failure latches: a later ready state
// must not repaint over it, and a second failure changes nothing. The raw error stays in the
// console; the callers log it, this module owns only what the visitor sees.

import type { EntryLobby } from './entry-lobby';

/** The one sentence every terminal startup failure shows; a reload is the whole recovery. */
export const STARTUP_FAILURE_MESSAGE = 'The showroom could not start. Reload to try again.';

export interface StartupFailureRouting {
  /** True once a terminal failure has been shown; later ready states must not overwrite it. */
  readonly failed: boolean;
  /** Shows the failure on the surface that owns the screen. Later calls do nothing. */
  fail(): void;
}

export interface StartupFailureOptions {
  /** The lobby, read at failure time: main assigns it before any failure can occur. */
  lobby: () => EntryLobby | null;
  /** The notice's Reload action. Default: a page reload. */
  reload?: () => void;
}

/**
 * Appends the page-level notice for a terminal startup failure: a title, the one sentence and a
 * Reload button, the only recovery a failed startup offers. A second call does not stack a
 * second notice.
 */
export function showStartupNotice(root: HTMLElement, reload: () => void): void {
  if (root.querySelector('.startup-notice') !== null) {
    return;
  }

  const doc = root.ownerDocument;
  const notice = doc.createElement('div');
  notice.className = 'startup-notice';
  notice.setAttribute('role', 'alert');

  const title = doc.createElement('p');
  title.className = 'startup-notice__title';
  title.textContent = 'Showroom could not load';

  const message = doc.createElement('p');
  message.className = 'startup-notice__message';
  message.textContent = STARTUP_FAILURE_MESSAGE;

  const reloadButton = doc.createElement('button');
  reloadButton.type = 'button';
  reloadButton.className = 'startup-notice__reload';
  reloadButton.textContent = 'Reload';
  reloadButton.addEventListener('click', () => reload());

  notice.append(title, message, reloadButton);
  root.appendChild(notice);
}

export function createStartupFailureRouting(options: StartupFailureOptions): StartupFailureRouting {
  const reload = options.reload ?? ((): void => {
    location.reload();
  });
  let failed = false;
  return {
    get failed(): boolean {
      return failed;
    },
    fail(): void {
      if (failed) {
        return;
      }
      failed = true;
      const lobby = options.lobby();
      // A revealed or disposed lobby no longer owns the screen; the notice takes over.
      if (lobby !== null && lobby.state !== 'disposed' && lobby.state !== 'revealed') {
        lobby.setError(STARTUP_FAILURE_MESSAGE);
        return;
      }
      showStartupNotice(document.body, reload);
    },
  };
}
