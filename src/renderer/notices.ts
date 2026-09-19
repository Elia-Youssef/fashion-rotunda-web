// Page-level notices in plain DOM, deliberately free of any three.js import: the poster renders
// on machines with no GPU support at all, and the loss notice renders when the GPU just died, so
// neither can depend on the renderer being alive. Both run under jsdom in the unit tests.
//
// `import type` below is erased at build time, so this module never pulls in three.js at runtime.

import type { DeviceLostInfo } from './create';

export interface PosterOptions {
  imageUrl: string;
  message: string;
  credit: string;
}

/**
 * Replaces the contents of `root` with the poster still, the message and the credit line. This is
 * the no-GPU path, so the image carries the scene and the message doubles as its alt text.
 * Idempotent by construction: `replaceChildren` drops the previous poster instead of stacking.
 */
export function showPoster(root: HTMLElement, options: PosterOptions): void {
  const image = document.createElement('img');
  image.className = 'poster__image';
  image.src = options.imageUrl;
  image.alt = options.message;

  const message = document.createElement('p');
  message.className = 'poster__message';
  message.textContent = options.message;

  const credit = document.createElement('small');
  credit.className = 'poster__credit';
  credit.textContent = options.credit;

  root.replaceChildren(image, message, credit);
}

/**
 * Appends a single role="alert" overlay with the loss reason, the renderer's message and a reload
 * button, the only recovery a dead GPU context offers. A second call does not duplicate: a
 * flapping context must not stack overlays on top of the first one.
 */
export function showLossNotice(root: HTMLElement, info: DeviceLostInfo, onReload: () => void): void {
  if (root.querySelector('.loss-notice') !== null) {
    return;
  }

  const notice = document.createElement('div');
  notice.className = 'loss-notice';
  notice.setAttribute('role', 'alert');

  const title = document.createElement('p');
  title.className = 'loss-notice__title';
  title.textContent = 'The graphics device was lost.';

  const reason = document.createElement('p');
  reason.className = 'loss-notice__reason';
  reason.textContent = `Reason: ${info.reason}`;

  const message = document.createElement('p');
  message.className = 'loss-notice__message';
  message.textContent = info.message;

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'loss-notice__reload';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => onReload());

  notice.append(title, reason, message, reload);
  root.appendChild(notice);
}
