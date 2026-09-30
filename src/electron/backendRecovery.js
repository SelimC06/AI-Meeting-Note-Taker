import { startBackend, stopBackend, waitForHealth, armCrashMonitor, getBackendLogTail, ensurePortFree } from './backend.js';
import { appendJsonLine } from './jsonlLog.js';

export function logCrash(logDir, { exitCode, signal, logTail }) {
    appendJsonLine(logDir, 'backend-crashes.log', { exitCode, signal, logTail });
}

let recovering = false;

export function isRecovering() {
    return recovering;
}

function sendStatus(mainWindow, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('backend:status', payload);
    }
}

export async function attemptRecovery({
    pythonExe,
    args,
    cwd,
    env,
    backendUrl,
    // The same per-launch token is reused for every respawn (it's already
    // in `env`): the renderers read it once at load, so a new token here
    // would lock them out of the recovered backend.
    authToken = null,
    // Optional: main.js no longer passes one (it forwards every push to
    // its CURRENT windows via onStatus instead), since a window captured
    // here is carried into every recursive re-arm below and goes stale if
    // the dashboard is ever recreated.
    mainWindow = null,
    logDir,
    crashInfo = null,
    delays = [0, 3000, 8000],
    healthTimeoutMs = 15000,
    isShuttingDown = () => false,
    // Optional side-channel invoked with every status payload alongside the
    // webContents.send above -- lets a caller (main.js) keep its own cache
    // of the current status authoritative even though this function talks
    // to the renderer directly, including for the recursive re-arm below
    // (a newly-recovered child crashing again later).
    onStatus = null,
}) {
    if (recovering) return;
    if (isShuttingDown()) return;
    recovering = true;
    const publish = (payload) => {
        sendStatus(mainWindow, payload);
        onStatus?.(payload);
    };
    try {
        if (crashInfo) {
            try {
                logCrash(logDir, { exitCode: crashInfo.exitCode, signal: crashInfo.signal, logTail: getBackendLogTail() });
            } catch (err) {
                console.error('[backendRecovery] failed to write crash log:', err.message);
            }
        }
        const maxAttempts = delays.length;
        for (let i = 0; i < maxAttempts; i++) {
            if (isShuttingDown()) return;
            const attempt = i + 1;
            if (delays[i] > 0) {
                await new Promise((resolve) => setTimeout(resolve, delays[i]));
            }
            if (isShuttingDown()) return;
            publish({ state: 'restarting', attempt, maxAttempts });
            try {
                // Stop whatever backend is still tracked -- a hung one the
                // watchdog gave up on, or a slow starter a Retry is
                // replacing -- and WAIT for it (SIGTERM, then SIGKILL, on
                // its whole process group), before checking the port.
                // ensurePortFree only finds a process once it's listening,
                // so one that hadn't bound the port yet used to survive,
                // untracked, alongside the new spawn.
                await stopBackend();
                if (isShuttingDown()) return;
                const freed = await ensurePortFree(Number(new URL(backendUrl).port), pythonExe);
                if (!freed) throw new Error('backend port is held by another process');
                const child = startBackend(pythonExe, args, cwd, env);
                if (isShuttingDown()) {
                    // Quit began between the check above and the spawn -- this
                    // child would outlive the app (before-quit's stopBackend
                    // already ran, against the previous process). Kill it and
                    // stop recovering.
                    await stopBackend();
                    return;
                }
                await waitForHealth(backendUrl, healthTimeoutMs, child, authToken);
                if (isShuttingDown()) {
                    await stopBackend();
                    return;
                }
                armCrashMonitor(child, (code, signal) => {
                    attemptRecovery({ pythonExe, args, cwd, env, backendUrl, authToken, mainWindow, logDir, crashInfo: { exitCode: code, signal }, delays, healthTimeoutMs, isShuttingDown, onStatus });
                });
                publish({ state: 'up' });
                return;
            } catch {
                // this attempt failed; kill the child we just spawned so it doesn't
                // linger as an orphaned process before the next attempt starts.
                await stopBackend();
            }
        }
        if (!isShuttingDown()) publish({ state: 'failed', logTail: getBackendLogTail() });
    } finally {
        recovering = false;
    }
}
