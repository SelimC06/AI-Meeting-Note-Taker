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
// held in the rail renderer's memory (pendingUploadsRef, offered back via the
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

// Reads the rail:stopAndSaveComplete ack payload ({ hasPendingUpload },
// sent by RailApp.tsx's ackStopAndSave). The ack is the only AUTHORITATIVE
// source for this at ack time: the rail:pushStatus copy is sent from a
// React effect a re-render later, so right after a stop-for-close upload
// fails, the cached value still says false. Anything that isn't a boolean
// (an older renderer, a timeout resolving with no payload, a malformed
// message) means "unknown" -- keep the cached value rather than guessing.
export function pendingUploadFromAck(payload, cachedHasPendingUpload) {
    const value = payload?.hasPendingUpload;
    return typeof value === 'boolean' ? value : cachedHasPendingUpload;
}

// performGuardedClose's decision logic (main.js), with its Electron-bound
// steps injected so the ordering can be unit-tested. hasPendingUpload is a
// getter, not a value, and is read only AFTER stopAndSave -- that stop's
// own upload may have just failed and joined the queue, which main.js
// learns from the ack (see pendingUploadFromAck) while stopAndSave is
// awaited. Returns true if the close should proceed.
export async function runGuardedClose({
    railStatus,
    isProcessing,
    hasPendingUpload,
    confirmClose,
    stopAndSave,
    confirmPendingUpload,
    retryUpload,
}) {
    if (shouldPromptBeforeClose(railStatus)) {
        const proceed = await confirmClose();
        if (!proceed) return false;
        await stopAndSave();
        // Falls through (no early return) to the pending-upload check below:
        // the rail queues every failed upload, so an OLDER failed recording
        // can still be pending behind the one just stopped and saved -- or
        // the just-stopped one's own upload may have failed.
    } else if (isProcessing) {
        // The recording itself already stopped (by the user's own manual
        // stop, not this close) and its upload is mid-flight -- there's
        // nothing to confirm here (no "keep recording" to cancel back into),
        // so just wait for that same upload to finish before windows get
        // destroyed, the same way before-quit silently waits out a
        // transcription job rather than popping a dialog for it.
        await stopAndSave();
        // Falls through for the same reason as the branch above.
    }
    if (hasPendingUpload()) {
        // Nothing is actively recording or uploading any more -- this is a
        // failed upload whose blob would otherwise be silently discarded
        // when the rail window is destroyed (G3).
        const choice = await confirmPendingUpload();
        if (choice === 'retry') {
            await retryUpload();
        }
        // 'discard' (or a retry that fails again) proceeds to close either
        // way -- the user already chose to close, this dialog only decided
        // whether to wait out one more attempt first.
    }
    return true;
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
