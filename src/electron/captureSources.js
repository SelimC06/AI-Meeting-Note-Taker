export const ALLOWED_CAPTURE_SOURCE_TYPES = ['screen', 'window'];

// desktopCapturer.getSources's `types` option is passed straight from the
// renderer over IPC; validate it against an allowlist here instead of
// trusting it, since a future or compromised renderer call could otherwise
// pass arbitrary values through this bridge.
export function sanitizeCaptureSourceTypes(types) {
    if (!Array.isArray(types)) return ALLOWED_CAPTURE_SOURCE_TYPES;
    return types.filter((t) => ALLOWED_CAPTURE_SOURCE_TYPES.includes(t));
}
