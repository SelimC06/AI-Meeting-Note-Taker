// Rail statuses under which a capture is actively live -- MediaRecorder
// buffers exist only in the rail renderer's memory, so destroying windows
// while any of these is current would silently discard them.
const ACTIVE_RAIL_STATUSES = new Set(['starting', 'recording', 'paused']);

export function shouldPromptBeforeClose(railStatus) {
    return ACTIVE_RAIL_STATUSES.has(railStatus);
}

// True whenever destroying the windows right now would risk losing data --
// either a live capture (shouldPromptBeforeClose) or a recording that's
// already stopped but whose upload (POST /process, running in the rail
// renderer) is still in flight. The latter used to slip through: rail status
// goes back to "idle" as soon as stop() resolves, well before the upload
// finishes, so a close arriving in that window skipped the guard entirely
// and killed the rail window (and the in-flight request with it) mid-upload.
export function needsCloseGuard(railStatus, isProcessing) {
    return shouldPromptBeforeClose(railStatus) || !!isProcessing;
}

// Mirrors the backend's JobStatus.status values (src/ui/api.ts) that mean
// "still working" -- 'done'/'failed' jobs are finished and don't need to
// block a quit.
export function hasActiveJob(jobs) {
    if (!Array.isArray(jobs)) return false;
    return jobs.some((j) => j?.status === 'queued' || j?.status === 'running');
}
