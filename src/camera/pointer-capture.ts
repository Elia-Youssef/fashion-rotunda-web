/** Pointer lifetime can end before a handler captures/releases it, including synthetic events. */
function pointerUnavailable(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === 'NotFoundError' || error.name === 'InvalidStateError');
}

export function capturePointer(element: Element, pointerId: number): boolean {
  if (typeof element.setPointerCapture !== 'function') return false;
  try {
    element.setPointerCapture(pointerId);
    return true;
  } catch (error) {
    if (pointerUnavailable(error)) return false;
    throw error;
  }
}

export function releasePointer(element: Element, pointerId: number): void {
  if (typeof element.releasePointerCapture !== 'function') return;
  try {
    if (typeof element.hasPointerCapture === 'function' && !element.hasPointerCapture(pointerId)) return;
    element.releasePointerCapture(pointerId);
  } catch (error) {
    // Ownership can disappear after the check. Detached elements cannot retain capture either.
    if (!pointerUnavailable(error)) throw error;
  }
}
