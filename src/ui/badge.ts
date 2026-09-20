// The backend badge in the side panel, the one piece of chrome that exists before the proof panel
// lands: every number a later goal shows must be readable against the backend that produced it.
//
// `import type` below is erased at build time, so this module stays DOM-only at runtime.

import type { Backend } from '../renderer/create';

export interface BadgeState {
  backend: Backend;
  gpuName: string;
  tier: string | null;
}

export interface BadgeHandle {
  update(next: Partial<BadgeState>): void;
  dispose(): void;
}

export function mountBadge(root: HTMLElement, state: BadgeState): BadgeHandle {
  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.setAttribute('role', 'status');

  const backendLabel = document.createElement('span');
  backendLabel.className = 'badge__backend';

  const tierLabel = document.createElement('span');
  tierLabel.className = 'badge__tier';

  badge.append(backendLabel, tierLabel);
  root.appendChild(badge);

  const current: BadgeState = { ...state };

  function render(): void {
    backendLabel.textContent = current.backend.toUpperCase();
    // The tier can arrive later; a null tier keeps the slot in the DOM but out of sight.
    tierLabel.textContent = current.tier;
    tierLabel.hidden = current.tier === null;
    // The GPU name is long and driver-flavoured; the tooltip is the place for it, not the panel.
    badge.removeAttribute('title');
    badge.dataset.tooltip = current.gpuName;
  }

  render();

  return {
    update(next: Partial<BadgeState>): void {
      // Absent keys keep their value; the update rewrites text only and never rebuilds the DOM.
      if (next.backend !== undefined) {
        current.backend = next.backend;
      }
      if (next.gpuName !== undefined) {
        current.gpuName = next.gpuName;
      }
      if (next.tier !== undefined) {
        current.tier = next.tier;
      }
      render();
    },
    dispose(): void {
      badge.remove();
    },
  };
}
