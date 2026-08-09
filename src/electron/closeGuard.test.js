import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPromptBeforeClose, hasActiveJob } from './closeGuard.js';

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
