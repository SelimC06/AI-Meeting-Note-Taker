import fs from 'node:fs';
import path from 'node:path';
import { startBackend, stopBackend, waitForHealth, armCrashMonitor, getBackendLogTail, ensurePortFree } from './backend.js';

export function logCrash(logDir, { exitCode, signal, logTail }) {
    fs.mkdirSync(logDir, { recursive: true });
    const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        exitCode,
        signal,
        logTail,
    });
    fs.appendFileSync(path.join(logDir, 'backend-crashes.log'), line + '\n');
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
    mainWindow,
    logDir,
    crashInfo = null,
    delays = [0, 3000, 8000],
    healthTimeoutMs = 15000,
}) {
    if (recovering) return;
    recovering = true;
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
            const attempt = i + 1;
            if (delays[i] > 0) {
                await new Promise((resolve) => setTimeout(resolve, delays[i]));
            }
            sendStatus(mainWindow, { state: 'restarting', attempt, maxAttempts });
            try {
                await ensurePortFree(Number(new URL(backendUrl).port));
                const child = startBackend(pythonExe, args, cwd, env);
                await waitForHealth(backendUrl, healthTimeoutMs, child);
                armCrashMonitor(child, (code, signal) => {
                    attemptRecovery({ pythonExe, args, cwd, env, backendUrl, mainWindow, logDir, crashInfo: { exitCode: code, signal }, delays, healthTimeoutMs });
                });
                sendStatus(mainWindow, { state: 'up' });
                return;
            } catch {
                // this attempt failed; kill the child we just spawned so it doesn't
                // linger as an orphaned process before the next attempt starts.
                stopBackend();
            }
        }
        sendStatus(mainWindow, { state: 'failed', logTail: getBackendLogTail() });
    } finally {
        recovering = false;
    }
}
