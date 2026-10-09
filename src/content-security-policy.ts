// Production document policy. Resource fetching stays on the document's origin.
export const CONTENT_SECURITY_POLICY = [
  // Unused resource classes, including fonts and media elements, have no network access.
  "default-src 'none'",
  // Vite's module scripts; Basis embind's Function constructor and both decoders' WebAssembly.
  // KTX2Loader's blob worker inherits this policy. No inline scripts are permitted.
  "script-src 'self' 'unsafe-eval'",
  // index.html and imported UI CSS become external Vite stylesheets. UI updates use CSSOM.
  "style-src 'self'",
  // index.html's poster and empty data favicon, plus catalogue thumbnails in the DOM.
  "img-src 'self' data:",
  // Catalogues, GLBs, collision, optional HDR, Basis JS/WASM and Web Audio music use fetch.
  // GLTFLoader creates blob URLs for embedded KTX2 images; KTX2Loader's FileLoader fetches them.
  "connect-src 'self' blob:",
  // KTX2Loader constructs its texture worker from the fetched Basis code in a blob URL.
  'worker-src blob:',
  // Content URLs are resolved by catalog/contentUrl; the document needs no base element.
  "base-uri 'none'",
  // The showroom canvas needs no plugin objects, embedded documents or form submissions.
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join('; ');
