// What main.js does when a window's renderer process dies (OOM kill, GPU
// crash, a native crash in capture code). Pure, so it's testable without
// Electron; main.js does the actual resetting, pushing and reloading.

// Shown in the dashboard (as the rail's error) after the rail's renderer
// died: whatever it was recording -- and any failed upload it was holding
// for a retry -- lived only in that process's memory.
export const RAIL_CRASH_NOTICE =
    'The recorder stopped unexpectedly — a recording in progress (or waiting to be uploaded) was lost.';

// The status main.js falls back to for a rail whose renderer is gone.
// Everything main cached from the dead page is void: status can't be
// "recording" any more (the recorder is gone), and hasPendingUpload is false
// rather than "keep the cached value" because the pending recordings were
// Blobs in that renderer's memory -- there is nothing left to retry, and
// offering Retry would send a command to a page that no longer has them.
export function railStatusAfterRendererGone() {
    return {
        status: 'idle',
        elapsedLabel: '00:00',
        level: [],
        recordError: RAIL_CRASH_NOTICE,
        recordErrorKind: 'generic',
        isProcessing: false,
        hasPendingUpload: false,
    };
}

// Keeps RAIL_CRASH_NOTICE on screen after the reloaded rail starts pushing
// its own (error-free, idle) status again -- otherwise the notice vanished
// the moment the reload finished, before anyone could read it. Cleared once
// the user starts a new recording.
export function withCrashNotice(status, notice) {
    if (!notice || status.status !== 'idle' || status.recordError) return status;
    return { ...status, recordError: notice, recordErrorKind: 'generic' };
}

// Reload a crashed renderer, but not in a tight loop: a page that dies
// again within this window of its last reload is left alone (and logged),
// instead of burning CPU crash-reloading forever.
export const RENDERER_RELOAD_MIN_INTERVAL_MS = 10000;

export function shouldReloadCrashedRenderer(lastReloadAt, now = Date.now()) {
    return lastReloadAt === null || now - lastReloadAt >= RENDERER_RELOAD_MIN_INTERVAL_MS;
}
