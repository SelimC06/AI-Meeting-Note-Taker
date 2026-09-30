// Which web permissions the app's own pages may use -- everything else is
// denied (Electron's default is to grant every permission request). Pure,
// for main.js's session.setPermissionRequestHandler / CheckHandler.
//
//   media                     getUserMedia: the microphone, and on Windows
//                             the chromeMediaSource:"desktop" system audio
//                             (src/rail/capture)
//   display-capture           getDisplayMedia: the screen recording
//   clipboard-sanitized-write navigator.clipboard.writeText (the Ollama
//                             setup gate's "Copy" button)
const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'clipboard-sanitized-write']);

// Only for the bundled file:// pages (both windows load nothing else -- see
// preventNavigation in main.js). An empty/unknown origin is denied.
export function isAllowedPermission(permission, requestingUrl) {
    if (!ALLOWED_PERMISSIONS.has(permission)) return false;
    return typeof requestingUrl === 'string' && requestingUrl.startsWith('file://');
}
