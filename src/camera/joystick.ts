// Goal G4.2: virtual on-screen joystick for touch walkthrough.
// Mounted on the canvas's parent, left half. Translates touch drags into a normalized vector
// (x: strafe left/right, y: forward/back), and resets to center on touch release.

import './joystick.css';

export interface JoystickHandle {
  readonly visible: boolean;
  setVisible(visible: boolean): void;
  dispose(): void;
}

const MAX_RADIUS = 36;

export function mountJoystick(
  root: HTMLElement,
  onVector: (x: number, y: number) => void,
): JoystickHandle {
  const container = document.createElement('div');
  container.className = 'archviz-joystick';
  container.hidden = true;

  const base = document.createElement('div');
  base.className = 'archviz-joystick-base';

  const knob = document.createElement('div');
  knob.className = 'archviz-joystick-knob';

  base.appendChild(knob);
  container.appendChild(base);
  root.appendChild(container);

  let activePointerId: number | null = null;
  let originX = 0;
  let originY = 0;
  let isVisible = false;

  function reset(): void {
    knob.style.transform = 'translate(0px, 0px)';
    activePointerId = null;
    onVector(0, 0);
  }

  function onPointerDown(event: PointerEvent): void {
    if (activePointerId !== null) {
      return;
    }
    activePointerId = event.pointerId;
    const rect = base.getBoundingClientRect();
    originX = rect.left + rect.width / 2;
    originY = rect.top + rect.height / 2;
    if (typeof base.setPointerCapture === 'function') {
      base.setPointerCapture(event.pointerId);
    }
    update(event.clientX, event.clientY);
  }

  function update(clientX: number, clientY: number): void {
    const dx = clientX - originX;
    const dy = clientY - originY;
    const dist = Math.hypot(dx, dy);
    const clampedDist = Math.min(dist, MAX_RADIUS);
    const angle = dist > 0 ? Math.atan2(dy, dx) : 0;

    const knobX = Math.cos(angle) * clampedDist;
    const knobY = Math.sin(angle) * clampedDist;
    knob.style.transform = `translate(${knobX.toFixed(1)}px, ${knobY.toFixed(1)}px)`;

    const normX = clampedDist > 0 ? knobX / MAX_RADIUS : 0;
    // Upwards drag has negative dy, which corresponds to positive forward motion.
    const normY = clampedDist > 0 ? -knobY / MAX_RADIUS : 0;
    onVector(normX, normY);
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== activePointerId) {
      return;
    }
    update(event.clientX, event.clientY);
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== activePointerId) {
      return;
    }
    if (typeof base.releasePointerCapture === 'function') {
      base.releasePointerCapture(event.pointerId);
    }
    reset();
  }

  base.addEventListener('pointerdown', onPointerDown);
  base.addEventListener('pointermove', onPointerMove);
  base.addEventListener('pointerup', onPointerUp);
  base.addEventListener('pointercancel', onPointerUp);

  return {
    get visible(): boolean {
      return isVisible;
    },
    setVisible(visible: boolean): void {
      isVisible = visible;
      container.hidden = !visible;
      if (!visible) {
        reset();
      }
    },
    dispose(): void {
      base.removeEventListener('pointerdown', onPointerDown);
      base.removeEventListener('pointermove', onPointerMove);
      base.removeEventListener('pointerup', onPointerUp);
      base.removeEventListener('pointercancel', onPointerUp);
      container.remove();
    },
  };
}
