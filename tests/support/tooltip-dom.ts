// Fixtures shared by the tooltip-dom suites: the anchor root installTooltips is called on, and
// the focus helpers that pin jsdom's :focus-visible answer. Each suite keeps its own live handle,
// so its hooks and teardown stay beside its tests.

/**
 * Two anchored buttons under one root, wired the way the page wires its tooltip triggers: the
 * first with no description of its own, the second carrying one the tooltip must preserve.
 */
export function mountTooltipDom(): {
  root: HTMLElement;
  btn1: HTMLButtonElement;
  btn2: HTMLButtonElement;
} {
  const root = document.createElement('div');
  document.body.appendChild(root);

  const btn1 = document.createElement('button');
  btn1.type = 'button';
  btn1.dataset.tooltip = 'First tooltip';
  root.appendChild(btn1);

  const btn2 = document.createElement('button');
  btn2.type = 'button';
  btn2.setAttribute('aria-describedby', 'existing-id');
  btn2.dataset.tooltip = 'Second tooltip';
  root.appendChild(btn2);

  return { root, btn1, btn2 };
}

/**
 * Focus as a keyboard user gives it. jsdom's :focus-visible answer depends on its own input
 * heuristics across tests, so the element states the browser's answer for keyboard focus.
 */
export function keyboardFocus(element: HTMLElement): void {
  answerFocusVisible(element, () => true);
  element.focus();
}

/** Replaces the element's answer to `:focus-visible`; every other selector matches as usual. */
export function answerFocusVisible(element: HTMLElement, answer: () => boolean): void {
  const matches = element.matches.bind(element);
  Object.defineProperty(element, 'matches', {
    configurable: true,
    value: (selector: string): boolean => (selector === ':focus-visible' ? answer() : matches(selector)),
  });
}
