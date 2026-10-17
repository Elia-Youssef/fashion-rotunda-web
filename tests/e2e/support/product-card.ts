// Shared setup of the product-card specs (ui-product-card*.spec.ts).
//
// The checks read DOM, layout, focus and the state attributes the page publishes, none of
// which the backend changes, so both projects run them: the shared showroom opening pins the
// page to the backend its project promises through the canvas data-backend attribute before
// any DOM reading, and waits on past the first frame to the mounted card, strip and mode
// buttons. The product card mounts only after the tier benchmark and the post chain settle,
// which on WebGPU outlasts the ready attribute.

export const SWITCH_TIMEOUT = 30_000;
export const CARD_PATH = '/?gate=off&e2e=1&proof=1';
