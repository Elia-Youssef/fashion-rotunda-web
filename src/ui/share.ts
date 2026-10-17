// Share UI component: Copy link and Screenshot actions in the side panel.
// Pure DOM manipulation with styling in share.css; holds no scene knowledge.

import './share.css';
import { sheetContentRoot } from './shell';

export interface ShareActions {
  copyLink(): Promise<void>;
  screenshot(): Promise<void>;
}

export interface ShareHandle {
  /** Shows a short confirmation ("Link copied", "Still saved") for 2 s. */
  notify(text: string): void;
  dispose(): void;
}

const NOTIFICATION_DURATION_MS = 2000;

export function mountShare(root: HTMLElement, actions: ShareActions): ShareHandle {
  const container = document.createElement('div');
  container.className = 'share';

  const actionsRow = document.createElement('div');
  actionsRow.className = 'share__actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'share__button share__button--copy';
  copyBtn.textContent = 'Copy link';

  const screenshotBtn = document.createElement('button');
  screenshotBtn.type = 'button';
  screenshotBtn.className = 'share__button share__button--screenshot';
  screenshotBtn.textContent = 'Screenshot';

  actionsRow.append(copyBtn, screenshotBtn);

  const fallbackInput = document.createElement('input');
  fallbackInput.type = 'text';
  fallbackInput.readOnly = true;
  fallbackInput.className = 'share__fallback share__fallback--hidden';
  fallbackInput.setAttribute('aria-label', 'Shareable link');

  const status = document.createElement('div');
  status.className = 'share__status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  container.append(actionsRow, fallbackInput, status);

  sheetContentRoot(root).appendChild(container);

  let notifyTimer: number | null = null;
  let disposed = false;
  const abortController = new AbortController();

  copyBtn.addEventListener(
    'click',
    () => {
      void actions.copyLink();
    },
    { signal: abortController.signal },
  );

  screenshotBtn.addEventListener(
    'click',
    () => {
      void actions.screenshot();
    },
    { signal: abortController.signal },
  );

  return {
    notify(text: string): void {
      if (disposed) return;
      if (notifyTimer !== null) {
        window.clearTimeout(notifyTimer);
      }
      status.textContent = text;
      notifyTimer = window.setTimeout(() => {
        status.textContent = '';
        notifyTimer = null;
      }, NOTIFICATION_DURATION_MS);
    },

    dispose(): void {
      disposed = true;
      abortController.abort();
      if (notifyTimer !== null) {
        window.clearTimeout(notifyTimer);
        notifyTimer = null;
      }
      container.remove();
    },
  };
}
