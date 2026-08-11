import { appendJsonLine } from './jsonlLog.js';

// Same shape/append-only format as backendRecovery.js's logCrash, so every
// crash log under userData/logs reads the same way.
export function appendCrashLog(logDir, filename, payload) {
    appendJsonLine(logDir, filename, payload);
}

function serializeError(err) {
    if (err instanceof Error) return { message: err.message, stack: err.stack };
    return { message: String(err) };
}

// Nothing previously caught an uncaught exception or unhandled rejection in
// the main process -- Electron's default behavior prints to a console that
// doesn't exist in a packaged app, so a crash here left zero trace for the
// user to hand back when reporting a bug. uncaughtException leaves the
// process in an unknown state, so (per Node's own guidance) we log then exit
// rather than resume; unhandledRejection is logged but left non-fatal.
export function armProcessCrashLogging(logDir, proc = process) {
    proc.on('uncaughtException', (err) => {
        appendCrashLog(logDir, 'main-crashes.log', { kind: 'uncaughtException', ...serializeError(err) });
        proc.exit(1);
    });
    proc.on('unhandledRejection', (reason) => {
        appendCrashLog(logDir, 'main-crashes.log', { kind: 'unhandledRejection', ...serializeError(reason) });
    });
}

// render-process-gone fires for benign exits too (e.g. clean-exit, killed),
// not just actual crashes -- don't log those as crashes.
const BENIGN_RENDER_GONE_REASONS = new Set(['clean-exit', 'killed']);

// The renderer *process* died outright (OOM kill, GPU crash, etc.) rather
// than just throwing a JS error the page could catch.
export function logRendererCrash(logDir, { reason, exitCode }) {
    if (BENIGN_RENDER_GONE_REASONS.has(reason)) return;
    appendCrashLog(logDir, 'renderer-crashes.log', { kind: 'render-process-gone', reason, exitCode });
}

// A JS error caught in the renderer (window.onerror / unhandledrejection)
// and forwarded here over IPC -- the renderer process is still alive, but
// this is the far more common failure mode for a React UI (a broken/blank
// screen) than an actual process death.
export function logRendererError(logDir, { kind, message, stack }) {
    appendCrashLog(logDir, 'renderer-errors.log', { kind, message, stack });
}
