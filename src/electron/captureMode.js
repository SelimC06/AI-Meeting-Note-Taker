// How the next getDisplayMedia() call from the rail should be answered:
//   'picker'    -- screen recording on (multimodal notes): let the user pick
//                  what to share via the macOS system picker, as before.
//   'audioOnly' -- screen recording off: grab system audio from the primary
//                  screen with no picker at all; the renderer drops the
//                  video track straight away and records audio only.
export const CAPTURE_MODES = ['picker', 'audioOnly'];

// Arrives over IPC from the rail renderer -- validate against the allowlist
// rather than trusting it, same as sanitizeCaptureSourceTypes.
export function sanitizeCaptureMode(mode) {
    return CAPTURE_MODES.includes(mode) ? mode : 'picker';
}

// Chromium features that let Electron's `audio: 'loopback'` display-media
// response capture system audio on macOS (it's Windows-only without them):
// ScreenCaptureKit-based loopback. Same set electron-audio-loopback enables.
export const MAC_LOOPBACK_FEATURES = [
    'MacLoopbackAudioForScreenShare',
    'MacSckSystemAudioLoopbackOverride',
];

// `--enable-features` is a single comma-separated switch -- appending a
// second one would override the first, so merge with anything already set.
export function mergeEnableFeatures(existing, features) {
    const current = (existing || '').split(',').map((f) => f.trim()).filter(Boolean);
    for (const f of features) {
        if (!current.includes(f)) current.push(f);
    }
    return current.join(',');
}
