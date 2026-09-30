import { appendJsonLine } from './jsonlLog.js';

// Same shape/append-only format as backendRecovery.js's logCrash, so every
// crash log under userData/logs reads the same way.
export function appendCrashLog(logDir, filename, payload, options) {
    appendJsonLine(logDir, filename, payload, options);
}

// Never throws: this runs inside crash handlers and IPC listeners, where a
// failed write (EPERM, disk full, a log dir on a vanished drive) used to
// escalate to an uncaughtException -- and so to exit(1) -- turning "couldn't
// write a log line" into "the whole app died". Returns whether it wrote.
export function safeAppendCrashLog(logDir, filename, payload, options) {
    try {
        appendCrashLog(logDir, filename, payload, options);
        return true;
    } catch (err) {
        console.error(`[crashLog] failed to write ${filename}:`, err?.message ?? err);
        return false;
    }
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
//
// beforeExit (optional) runs between the log write and exit(1): exit skips
// before-quit entirely, so main.js passes a synchronous backend kill here --
// otherwise the (detached) backend and its ffmpeg children outlived the
// crash and held the port on the next launch. Both it and the log write are
// guarded, so neither can throw out of this handler and recurse into it.
export function armProcessCrashLogging(logDir, proc = process, { beforeExit = null } = {}) {
    proc.on('uncaughtException', (err) => {
        safeAppendCrashLog(logDir, 'main-crashes.log', { kind: 'uncaughtException', ...serializeError(err) });
        try {
            beforeExit?.();
        } catch (hookErr) {
            console.error('[crashLog] beforeExit hook failed:', hookErr?.message ?? hookErr);
        }
        proc.exit(1);
    });
    proc.on('unhandledRejection', (reason) => {
        safeAppendCrashLog(logDir, 'main-crashes.log', { kind: 'unhandledRejection', ...serializeError(reason) });
    });
}

// render-process-gone fires for benign exits too (e.g. clean-exit, killed),
// not just actual crashes -- don't log those as crashes.
const BENIGN_RENDER_GONE_REASONS = new Set(['clean-exit', 'killed']);

// The renderer *process* died outright (OOM kill, GPU crash, etc.) rather
// than just throwing a JS error the page could catch.
export function logRendererCrash(logDir, { reason, exitCode }) {
    if (BENIGN_RENDER_GONE_REASONS.has(reason)) return;
    safeAppendCrashLog(logDir, 'renderer-crashes.log', { kind: 'render-process-gone', reason, exitCode });
}

// Caps for what a renderer can put in renderer-errors.log: the payload
// arrives over IPC, so its shape and size are whatever the page sent.
export const RENDERER_ERROR_FIELD_MAX_CHARS = { kind: 64, message: 2000, stack: 8000 };
export const RENDERER_ERRORS_LOG_MAX_BYTES = 1024 * 1024;

function clampString(value, maxChars) {
    if (typeof value !== 'string') return null;
    return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

// Returns the sanitized record, or null for a payload that isn't an object
// at all (dropped). Used to destructure the payload directly -- a null or
// non-object payload threw inside the IPC listener, which took the app down.
export function sanitizeRendererErrorPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    return {
        kind: clampString(payload.kind, RENDERER_ERROR_FIELD_MAX_CHARS.kind) ?? 'unknown',
        message: clampString(payload.message, RENDERER_ERROR_FIELD_MAX_CHARS.message) ?? '',
        stack: clampString(payload.stack, RENDERER_ERROR_FIELD_MAX_CHARS.stack),
    };
}

// A JS error caught in the renderer (window.onerror / unhandledrejection)
// and forwarded here over IPC -- the renderer process is still alive, but
// this is the far more common failure mode for a React UI (a broken/blank
// screen) than an actual process death. Rotated at
// RENDERER_ERRORS_LOG_MAX_BYTES: a page erroring in a render loop can
// report thousands of these a minute. Returns whether a line was written.
export function logRendererError(logDir, payload) {
    const record = sanitizeRendererErrorPayload(payload);
    if (!record) return false;
    return safeAppendCrashLog(logDir, 'renderer-errors.log', record, { maxBytes: RENDERER_ERRORS_LOG_MAX_BYTES });
}
