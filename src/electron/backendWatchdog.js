// A backend that deadlocks without exiting (e.g. stuck in a blocking call)
// never fires the child process's 'exit' event, so armCrashMonitor's
// crash-triggered recovery never runs -- the app would show "stopped"
// forever with no automatic recovery and, before this file existed, no way
// for the user to retry it either. This module probes /health on an
// interval while the process is otherwise alive and asks the same recovery
// path (attemptRecovery in backendRecovery.js) to kill and restart it once
// enough consecutive probes fail.

import { backendAuthHeaders } from './backend.js';
import { hasActiveJob } from './closeGuard.js';

export const WATCHDOG_FAILURE_THRESHOLD = 3;
export const WATCHDOG_PROBE_TIMEOUT_MS = 3000;
export const WATCHDOG_INTERVAL_MS = 5000;

// While a transcription job is known to be queued/running, the backend is
// expected to miss probes: Whisper/pyannote/ffmpeg saturate every core, and
// /health then can't get a thread in time. 3 misses (~15s) used to kill it
// mid-transcription -- losing the job the user was waiting on. Restarts
// aren't switched off entirely while busy, though: a backend that genuinely
// deadlocks mid-job is exactly what this watchdog exists for, so it still
// gets recovered, just after 60 consecutive misses (~5 minutes of total
// silence) instead of 3. Real CPU saturation lets an occasional probe
// through well within that, which resets the count.
export const WATCHDOG_BUSY_FAILURE_THRESHOLD = 60;
export const WATCHDOG_JOBS_TIMEOUT_MS = 1500;

export function watchdogThreshold(backendBusy) {
    return backendBusy ? WATCHDOG_BUSY_FAILURE_THRESHOLD : WATCHDOG_FAILURE_THRESHOLD;
}

// Asks the backend's own /jobs (the same endpoint the quit guard and the
// renderers' useProcessingJobs poll) whether a job is queued or running.
// true/false, or null when it couldn't tell (unreachable, timeout, bad
// response) -- the caller keeps its last known answer in that case, since
// "can't reach /jobs" is exactly what a busy backend looks like.
export async function fetchBackendBusy(backendUrl, authToken = null, timeoutMs = WATCHDOG_JOBS_TIMEOUT_MS) {
    try {
        const res = await fetch(`${backendUrl}/jobs`, {
            headers: backendAuthHeaders(authToken),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        return hasActiveJob(await res.json());
    } catch {
        return null;
    }
}

// Pure decision function, kept separate from the actual network probe so it
// can be tested without spawning a process or a real/fake server: given
// whether the latest probe succeeded and how many consecutive failures
// preceded it, decides the new consecutive-failure count and whether that's
// now enough to warrant killing and restarting the backend.
export function nextWatchdogState(prevConsecutiveFailures, probeOk, threshold = WATCHDOG_FAILURE_THRESHOLD) {
    if (probeOk) {
        return { consecutiveFailures: 0, shouldRestart: false };
    }
    const consecutiveFailures = prevConsecutiveFailures + 1;
    return { consecutiveFailures, shouldRestart: consecutiveFailures >= threshold };
}

// Bare success/failure -- callers that need the response body use something
// else; the watchdog only cares whether the backend answered at all.
// AbortSignal.timeout guards against the exact gap this module exists to
// close: a hung backend that accepts the TCP connection but never responds
// would otherwise leave a plain fetch() pending forever.
// authToken: the per-launch backend token -- without it /health answers 401,
// which would read as "unhealthy" and get a perfectly fine backend killed.
export async function probeHealthOnce(backendUrl, timeoutMs = WATCHDOG_PROBE_TIMEOUT_MS, authToken = null) {
    try {
        const res = await fetch(`${backendUrl}/health`, {
            headers: backendAuthHeaders(authToken),
            signal: AbortSignal.timeout(timeoutMs),
        });
        return res.ok;
    } catch {
        return false;
    }
}
