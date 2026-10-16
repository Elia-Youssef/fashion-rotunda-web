// attract=0 keeps the idle tour from starting after 60 s and rendering every frame, and post=off
// drops the post chain; both only slow the software renderer, and these checks are DOM layout.
// Every project runs the suite on its own backend: the shared showroom opening pins the page to
// the backend its project promises through the canvas data-backend attribute before any DOM
// reading, and waits on past the first frame to the mounted strip and card.
export const RAIL_PATH = '/?gate=off&e2e=1&proof=1&attract=0&post=off';
