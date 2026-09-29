import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPromptBeforeClose, needsCloseGuard, hasActiveJob, runInstallShutdownSequence, beforeQuitStep } from './closeGuard.js';

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

test('needsCloseGuard is true when idle and not processing but a failed upload is still pending retry (G3)', () => {
    // The bug this guards against: a failed upload leaves its blob in
    // pendingUploadRef with status back to "idle" and isProcessing false --
    // without hasPendingUpload, close proceeds with no dialog and destroys
    // the rail window (and the only copy of that recording) silently.
    assert.equal(needsCloseGuard('idle', false, true), true);
});

test('needsCloseGuard is false when idle, not processing, and nothing is pending', () => {
    assert.equal(needsCloseGuard('idle', false, false), false);
    assert.equal(needsCloseGuard('idle', false, undefined), false);
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

test('runInstallShutdownSequence stops the watchdog and marks shutting-down/quit-requested before the jobs wait', async () => {
    const calls = [];
    await runInstallShutdownSequence({
        stopHealthWatchdog: () => calls.push('stopHealthWatchdog'),
        markShuttingDown: () => calls.push('markShuttingDown'),
        markQuitRequested: () => calls.push('markQuitRequested'),
        destroyAllWindows: () => calls.push('destroyAllWindows'),
        fetchActiveJobsForQuitGuard: async () => {
            calls.push('fetchActiveJobsForQuitGuard');
            return [{ status: 'running' }];
        },
        waitForActiveJobsToFinish: async () => calls.push('waitForActiveJobsToFinish'),
    });

    assert.deepEqual(calls, [
        'stopHealthWatchdog',
        'markShuttingDown',
        'markQuitRequested',
        'destroyAllWindows',
        'fetchActiveJobsForQuitGuard',
        'waitForActiveJobsToFinish',
    ]);
});

test('runInstallShutdownSequence skips the jobs wait when nothing is active', async () => {
    const calls = [];
    await runInstallShutdownSequence({
        stopHealthWatchdog: () => calls.push('stopHealthWatchdog'),
        markShuttingDown: () => calls.push('markShuttingDown'),
        markQuitRequested: () => calls.push('markQuitRequested'),
        destroyAllWindows: () => calls.push('destroyAllWindows'),
        fetchActiveJobsForQuitGuard: async () => [{ status: 'done' }],
        waitForActiveJobsToFinish: async () => calls.push('waitForActiveJobsToFinish'),
    });

    assert.ok(!calls.includes('waitForActiveJobsToFinish'));
});

test('beforeQuitStep guards first, before anything else, until the guard has passed', () => {
    // The bug this guards against: Cmd+Q / Dock "Quit" / logout went
    // straight to isQuitting (letting every window close unguarded) and
    // destroyed a live recording -- only the in-app X button was guarded.
    assert.equal(beforeQuitStep({ closeConfirmed: false, quitConfirmed: false, beforeQuitInFlight: false }), 'guard');
    // Even flags left over from another path must not skip the guard.
    assert.equal(beforeQuitStep({ closeConfirmed: false, quitConfirmed: true, beforeQuitInFlight: false }), 'guard');
    assert.equal(beforeQuitStep({ closeConfirmed: false, quitConfirmed: false, beforeQuitInFlight: true }), 'guard');
});

test('beforeQuitStep walks guard -> waitForJobs -> keepWaiting -> finish once confirmed', () => {
    assert.equal(beforeQuitStep({ closeConfirmed: true, quitConfirmed: false, beforeQuitInFlight: false }), 'waitForJobs');
    assert.equal(beforeQuitStep({ closeConfirmed: true, quitConfirmed: false, beforeQuitInFlight: true }), 'keepWaiting');
    assert.equal(beforeQuitStep({ closeConfirmed: true, quitConfirmed: true, beforeQuitInFlight: false }), 'finish');
});
