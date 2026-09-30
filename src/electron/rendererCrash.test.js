import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    RAIL_CRASH_NOTICE,
    railStatusAfterRendererGone,
    withCrashNotice,
    shouldReloadCrashedRenderer,
    RENDERER_RELOAD_MIN_INTERVAL_MS,
} from './rendererCrash.js';
import { sanitizeRailStatus } from './railValidation.js';
import { needsCloseGuard } from './closeGuard.js';

test('a dead rail falls back to idle with nothing pending, so closing no longer asks to stop or retry', () => {
    const status = railStatusAfterRendererGone();
    assert.equal(status.status, 'idle');
    assert.equal(status.hasPendingUpload, false);
    assert.equal(status.isProcessing, false);
    assert.equal(status.recordError, RAIL_CRASH_NOTICE);
    // It's a valid rail status (the dashboard receives it like any push)...
    assert.deepEqual(sanitizeRailStatus(status), status);
    // ...and nothing about it needs the recording guard any more.
    assert.equal(needsCloseGuard(status.status, status.isProcessing, status.hasPendingUpload), false);
});

test('withCrashNotice keeps the notice on an idle, error-free status only', () => {
    const idle = { status: 'idle', recordError: null, recordErrorKind: null };
    assert.equal(withCrashNotice(idle, RAIL_CRASH_NOTICE).recordError, RAIL_CRASH_NOTICE);
    assert.equal(withCrashNotice(idle, null), idle);
    const recording = { status: 'recording', recordError: null };
    assert.equal(withCrashNotice(recording, RAIL_CRASH_NOTICE), recording);
    const otherError = { status: 'idle', recordError: 'Upload failed' };
    assert.equal(withCrashNotice(otherError, RAIL_CRASH_NOTICE), otherError);
});

test('crashed renderers are reloaded, but not in a crash loop', () => {
    assert.equal(shouldReloadCrashedRenderer(null, 1000), true);
    assert.equal(shouldReloadCrashedRenderer(1000, 1000 + RENDERER_RELOAD_MIN_INTERVAL_MS - 1), false);
    assert.equal(shouldReloadCrashedRenderer(1000, 1000 + RENDERER_RELOAD_MIN_INTERVAL_MS), true);
});
