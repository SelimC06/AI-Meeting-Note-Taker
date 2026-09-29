import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPromptBeforeClose, needsCloseGuard, hasActiveJob, runInstallShutdownSequence, beforeQuitStep, pendingUploadFromAck, runGuardedClose } from './closeGuard.js';

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

test('pendingUploadFromAck trusts a boolean hasPendingUpload in the ack payload', () => {
    assert.equal(pendingUploadFromAck({ hasPendingUpload: true }, false), true);
    assert.equal(pendingUploadFromAck({ hasPendingUpload: false }, true), false);
});

test('pendingUploadFromAck keeps the cached value when the payload is missing or malformed', () => {
    // A timeout resolves with no payload; an older renderer acks with none.
    assert.equal(pendingUploadFromAck(undefined, true), true);
    assert.equal(pendingUploadFromAck(null, false), false);
    assert.equal(pendingUploadFromAck({}, true), true);
    assert.equal(pendingUploadFromAck({ hasPendingUpload: 'yes' }, false), false);
    assert.equal(pendingUploadFromAck({ hasPendingUpload: 1 }, false), false);
});

// Mirrors main.js: lastRailHasPendingUpload is only refreshed from the ack
// while stopAndSave is being awaited, the way waitForStopAck does it.
function guardedCloseHarness({ railStatus, isProcessing = false, cachedHasPendingUpload, ackPayload, pendingChoice = 'discard' }) {
    const calls = [];
    let lastRailHasPendingUpload = cachedHasPendingUpload;
    const run = () => runGuardedClose({
        railStatus,
        isProcessing,
        hasPendingUpload: () => lastRailHasPendingUpload,
        confirmClose: async () => { calls.push('confirmClose'); return true; },
        stopAndSave: async () => {
            calls.push('stopAndSave');
            lastRailHasPendingUpload = pendingUploadFromAck(ackPayload, lastRailHasPendingUpload);
        },
        confirmPendingUpload: async () => { calls.push('confirmPendingUpload'); return pendingChoice; },
        retryUpload: async () => { calls.push('retryUpload'); },
    });
    return { calls, run };
}

test('runGuardedClose shows the pending-upload dialog when the stop-for-close upload fails, even though the cached push still says false', async () => {
    // The bug: the ack arrives before the rail's status push, so the cached
    // flag is stale (false) -- only the ack payload knows the upload failed.
    const { calls, run } = guardedCloseHarness({
        railStatus: 'recording',
        cachedHasPendingUpload: false,
        ackPayload: { hasPendingUpload: true },
        pendingChoice: 'retry',
    });
    assert.equal(await run(), true);
    assert.deepEqual(calls, ['confirmClose', 'stopAndSave', 'confirmPendingUpload', 'retryUpload']);
});

test('runGuardedClose shows the pending-upload dialog after waiting out an in-flight upload that then fails', async () => {
    const { calls, run } = guardedCloseHarness({
        railStatus: 'idle',
        isProcessing: true,
        cachedHasPendingUpload: false,
        ackPayload: { hasPendingUpload: true },
    });
    assert.equal(await run(), true);
    assert.deepEqual(calls, ['stopAndSave', 'confirmPendingUpload']);
});

test('runGuardedClose skips the pending-upload dialog when the ack says nothing is pending, even if the cached push said otherwise', async () => {
    const { calls, run } = guardedCloseHarness({
        railStatus: 'recording',
        cachedHasPendingUpload: true,
        ackPayload: { hasPendingUpload: false },
    });
    assert.equal(await run(), true);
    assert.deepEqual(calls, ['confirmClose', 'stopAndSave']);
});

test('runGuardedClose falls back to the cached flag when the ack carries no payload (e.g. timeout)', async () => {
    const { calls, run } = guardedCloseHarness({
        railStatus: 'recording',
        cachedHasPendingUpload: true,
        ackPayload: undefined,
    });
    await run();
    assert.deepEqual(calls, ['confirmClose', 'stopAndSave', 'confirmPendingUpload']);
});

test('runGuardedClose returns false without stopping when the user cancels the recording dialog', async () => {
    const calls = [];
    const proceed = await runGuardedClose({
        railStatus: 'recording',
        isProcessing: false,
        hasPendingUpload: () => true,
        confirmClose: async () => { calls.push('confirmClose'); return false; },
        stopAndSave: async () => { calls.push('stopAndSave'); },
        confirmPendingUpload: async () => { calls.push('confirmPendingUpload'); return 'discard'; },
        retryUpload: async () => { calls.push('retryUpload'); },
    });
    assert.equal(proceed, false);
    assert.deepEqual(calls, ['confirmClose']);
});
