// Rail statuses under which a capture is actively live -- MediaRecorder
// buffers exist only in the rail renderer's memory, so destroying windows
// while any of these is current would silently discard them.
const ACTIVE_RAIL_STATUSES = new Set(['starting', 'recording', 'paused']);

export function shouldPromptBeforeClose(railStatus) {
    return ACTIVE_RAIL_STATUSES.has(railStatus);
}

// Mirrors the backend's JobStatus.status values (src/ui/api.ts) that mean
// "still working" -- 'done'/'failed' jobs are finished and don't need to
// block a quit.
export function hasActiveJob(jobs) {
    if (!Array.isArray(jobs)) return false;
    return jobs.some((j) => j?.status === 'queued' || j?.status === 'running');
}
