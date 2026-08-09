import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPromptBeforeClose, needsCloseGuard, hasActiveJob } from './closeGuard.js';

test('shouldPromptBeforeClose is true for starting, recording, and paused', () => {
    assert.equal(shouldPromptBeforeClose('starting'), true);
    assert.equal(shouldPromptBeforeClose('recording'), true);
    assert.equal(shouldPromptBeforeClose('paused'), true);
});

test('shouldPromptBeforeClose is false for idle and unknown/undefined statuses', () => {
    assert.equal(shouldPromptBeforeClose('idle'), false);
    assert.equal(shouldPromptBeforeClose(undefined), false);
    assert.equal(shouldPromptBeforeClose(null), false);
    assert.equal(shouldPromptBeforeClose('bogus'), false);
});

test('needsCloseGuard is true while actively recording, regardless of isProcessing', () => {
    assert.equal(needsCloseGuard('recording', false), true);
    assert.equal(needsCloseGuard('starting', false), true);
    assert.equal(needsCloseGuard('paused', false), true);
});

test('needsCloseGuard is true when idle but an upload is still in flight', () => {
    // The bug this guards against: status flips back to "idle" as soon as
    // stop() resolves, well before the POST /process upload it kicked off
    // has finished -- a close arriving in that window must still be guarded.
    assert.equal(needsCloseGuard('idle', true), true);
});

test('needsCloseGuard is false when idle and nothing is uploading', () => {
    assert.equal(needsCloseGuard('idle', false), false);
    assert.equal(needsCloseGuard(undefined, undefined), false);
});

test('hasActiveJob is true when any job is queued or running', () => {
    assert.equal(hasActiveJob([{ status: 'queued' }]), true);
    assert.equal(hasActiveJob([{ status: 'done' }, { status: 'running' }]), true);
});

test('hasActiveJob is false when all jobs are done/failed or the list is empty', () => {
    assert.equal(hasActiveJob([]), false);
    assert.equal(hasActiveJob([{ status: 'done' }, { status: 'failed' }]), false);
});

test('hasActiveJob is false for non-array input', () => {
    assert.equal(hasActiveJob(undefined), false);
    assert.equal(hasActiveJob(null), false);
});
