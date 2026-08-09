// A backend that deadlocks without exiting (e.g. stuck in a blocking call)
// never fires the child process's 'exit' event, so armCrashMonitor's
// crash-triggered recovery never runs -- the app would show "stopped"
// forever with no automatic recovery and, before this file existed, no way
// for the user to retry it either. This module probes /health on an
// interval while the process is otherwise alive and asks the same recovery
// path (attemptRecovery in backendRecovery.js) to kill and restart it once
// enough consecutive probes fail.

export const WATCHDOG_FAILURE_THRESHOLD = 3;
export const WATCHDOG_PROBE_TIMEOUT_MS = 3000;
export const WATCHDOG_INTERVAL_MS = 5000;

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
export async function probeHealthOnce(backendUrl, timeoutMs = WATCHDOG_PROBE_TIMEOUT_MS) {
    try {
        const res = await fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
        return res.ok;
    } catch {
        return false;
    }
}
