// Content-Security-Policy for the app's two pages (index.html, rail.html),
// injected into the production build by vite.config.ts. Defense in depth:
// both pages only ever load their own bundled files and talk to the local
// backend, so anything else -- an injected <script>, a stray fetch to
// another host -- is refused even if something slips past the rest.
//
// Not applied to `vite` dev mode: the React refresh runtime needs an inline
// script and a websocket to the dev server there.
//
// - style-src 'unsafe-inline': rail.html's body/root carry inline style
//   attributes, and Tailwind/React set styles at runtime.
// - connect-src http://127.0.0.1:*: the backend, on whichever port main
//   picked (BACKEND_URL in api.ts).
// - font-src data:: Vite inlines the smaller JetBrains Mono subsets as
//   data: URLs (found by loading the built app and checking the console).
// - img/media blob: data:: object URLs (export downloads) and small inline
//   images.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join("; ");
