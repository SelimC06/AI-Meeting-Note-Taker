// Rail statuses under which a capture is actively live -- MediaRecorder
// buffers exist only in the rail renderer's memory, so destroying windows
// while any of these is current would silently discard them.
const ACTIVE_RAIL_STATUSES = new Set(['starting', 'recording', 'paused']);

export function shouldPromptBeforeClose(railStatus) {
    return ACTIVE_RAIL_STATUSES.has(railStatus);
}

// True whenever destroying the windows right now would risk losing data --
// a live capture (shouldPromptBeforeClose), a recording that's already
// stopped but whose upload (POST /process, running in the rail renderer) is
// still in flight, or a PREVIOUSLY FAILED upload whose blob is still only
// held in the rail renderer's memory (pendingUploadRef, offered back via the
// "retry upload" toast action). The in-flight case used to slip through:
// rail status goes back to "idle" as soon as stop() resolves, well before
// the upload finishes, so a close arriving in that window skipped the guard
// entirely and killed the rail window (and the in-flight request with it)
// mid-upload. The pending-upload case is the same hole for a recording that
// already finished failing to upload: status is "idle" and isProcessing is
// false, so without hasPendingUpload the close proceeds with no dialog at
// all, silently discarding the only copy of that recording.
export function needsCloseGuard(railStatus, isProcessing, hasPendingUpload) {
    return shouldPromptBeforeClose(railStatus) || !!isProcessing || !!hasPendingUpload;
}

// Mirrors the backend's JobStatus.status values (src/ui/api.ts) that mean
// "still working" -- 'done'/'failed' jobs are finished and don't need to
// block a quit.
export function hasActiveJob(jobs) {
    if (!Array.isArray(jobs)) return false;
    return jobs.some((j) => j?.status === 'queued' || j?.status === 'running');
}

// Shared by updater:install and before-quit: stop the health watchdog and
// mark the app as shutting down BEFORE the jobs wait below, not after --
// otherwise a CPU-saturated backend missing watchdog probes during the wait
// gets kill-restarted by attemptRecovery mid-transcription, destroying the
// very job the wait exists to protect. Callbacks are injected (rather than
// this module touching main.js's module-level state/Electron APIs directly)
// so the ordering can be unit-tested without a full Electron harness.
export async function runInstallShutdownSequence({
    stopHealthWatchdog,
    markShuttingDown,
    markQuitRequested,
    destroyAllWindows,
    fetchActiveJobsForQuitGuard,
    waitForActiveJobsToFinish,
}) {
    stopHealthWatchdog();
    markShuttingDown();
    markQuitRequested();
    destroyAllWindows();
    const jobs = await fetchActiveJobsForQuitGuard();
    if (hasActiveJob(jobs)) {
        await waitForActiveJobsToFinish();
    }
}

// What before-quit should do on this entry. Every native quit gesture
// (Cmd+Q, Dock "Quit", logout, a bare app.quit()) re-enters before-quit
// several times on its way out, and the order matters:
//   'guard'       -- the recording guard hasn't passed yet: run it FIRST,
//                    before anything marks the app as quitting (that's what
//                    lets windows close unguarded). Used to be skipped
//                    entirely for everything but the in-app close button.
//   'finish'      -- guard passed and the active-job wait is done: stop the
//                    backend and let the quit through.
//   'keepWaiting' -- the job wait from an earlier entry is still running.
//   'waitForJobs' -- guard passed, start the (silent) active-job wait.
export function beforeQuitStep({ closeConfirmed, quitConfirmed, beforeQuitInFlight }) {
    if (!closeConfirmed) return 'guard';
    if (quitConfirmed) return 'finish';
    if (beforeQuitInFlight) return 'keepWaiting';
    return 'waitForJobs';
}
