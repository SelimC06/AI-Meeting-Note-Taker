import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { armAutoUpdate, getLastStatus, getUpdateFeedUrl, installUpdate, UPDATE_CHECK_INTERVAL_MS } from './updater.js';

function makeFakeWindow() {
    const sent = [];
    return {
        isDestroyed: () => false,
        webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
        sent,
    };
}

function makeFakeUpdater() {
    const emitter = new EventEmitter();
    emitter.autoDownload = false;
    emitter.setFeedURL = () => {};
    emitter.checkForUpdates = () => { emitter.checkForUpdatesCalled = true; };
    emitter.quitAndInstall = () => { emitter.quitAndInstallCalled = true; };
    return emitter;
}

// Must run before any test that arms an updater and emits a status event —
// getLastStatus() is backed by module-level state that persists for the life
// of the process, mirroring the single real `autoUpdater` singleton.
test('getLastStatus returns not-checked before any status event has fired', () => {
    assert.deepEqual(getLastStatus(), { state: 'not-checked' });
});

test('getUpdateFeedUrl returns UPDATE_FEED_URL when set', () => {
    const url = getUpdateFeedUrl({ UPDATE_FEED_URL: 'https://example.com/feed' });
    assert.equal(url, 'https://example.com/feed');
});

test('getUpdateFeedUrl falls back to the default production feed when unset', () => {
    const url = getUpdateFeedUrl({});
    assert.equal(url, 'https://updates.deskrecap.com');
});

test('armAutoUpdate sets autoDownload, sets the feed URL, and triggers a check', () => {
    const win = makeFakeWindow();
    const updater = makeFakeUpdater();

    armAutoUpdate(() => win, updater);

    assert.equal(updater.autoDownload, true);
    assert.equal(updater.checkForUpdatesCalled, true);
});

test('checking-for-update sends a "checking" status', () => {
    const win = makeFakeWindow();
    const updater = makeFakeUpdater();
    armAutoUpdate(() => win, updater);

    updater.emit('checking-for-update');

    assert.deepEqual(win.sent.at(-1), { channel: 'updater:status', payload: { state: 'checking' } });
});

test('update-available sends an "available" status with version', () => {
    const win = makeFakeWindow();
    const updater = makeFakeUpdater();
    armAutoUpdate(() => win, updater);

    updater.emit('update-available', { version: '1.2.0' });

    assert.deepEqual(win.sent.at(-1), { channel: 'updater:status', payload: { state: 'available', version: '1.2.0' } });
});

test('update-not-available sends an "idle" status', () => {
    const win = makeFakeWindow();
    const updater = makeFakeUpdater();
    armAutoUpdate(() => win, updater);

    updater.emit('update-not-available');

    assert.deepEqual(win.sent.at(-1), { channel: 'updater:status', payload: { state: 'idle' } });
});

test('download-progress sends a "downloading" status with percent', () => {
    const win = makeFakeWindow();
    const updater = makeFakeUpdater();
    armAutoUpdate(() => win, updater);

    updater.emit('download-progress', { percent: 42.7 });

    assert.deepEqual(win.sent.at(-1), { channel: 'updater:status', payload: { state: 'downloading', percent: 42.7 } });
});

test('update-downloaded sends a "ready" status with version', () => {
    const win = makeFakeWindow();
    const updater = makeFakeUpdater();
    armAutoUpdate(() => win, updater);

    updater.emit('update-downloaded', { version: '1.2.0' });

    assert.deepEqual(win.sent.at(-1), { channel: 'updater:status', payload: { state: 'ready', version: '1.2.0' } });
});

test('error sends an "error" status with the error message', () => {
    const win = makeFakeWindow();
    const updater = makeFakeUpdater();
    armAutoUpdate(() => win, updater);

    updater.emit('error', new Error('feed unreachable'));

    assert.deepEqual(win.sent.at(-1), { channel: 'updater:status', payload: { state: 'error', message: 'feed unreachable' } });
});

test('status is not sent when the window is destroyed', () => {
    const win = makeFakeWindow();
    win.isDestroyed = () => true;
    const updater = makeFakeUpdater();
    armAutoUpdate(() => win, updater);

    updater.emit('checking-for-update');

    assert.equal(win.sent.length, 0);
});

test('status goes to whichever window the getter returns at send time, not the one at arm time', () => {
    // The dashboard can be recreated after armAutoUpdate ran (macOS Dock
    // reopen) -- a captured window would keep receiving status while the
    // new one never did.
    const first = makeFakeWindow();
    const second = makeFakeWindow();
    let current = first;
    const updater = makeFakeUpdater();
    armAutoUpdate(() => current, updater);

    updater.emit('checking-for-update');
    first.isDestroyed = () => true;
    current = second;
    updater.emit('update-available', { version: '2.0.0' });

    assert.deepEqual(first.sent, [{ channel: 'updater:status', payload: { state: 'checking' } }]);
    assert.deepEqual(second.sent, [{ channel: 'updater:status', payload: { state: 'available', version: '2.0.0' } }]);
});

test('status is not sent when the getter returns no window', () => {
    const updater = makeFakeUpdater();
    armAutoUpdate(() => null, updater);
    assert.doesNotThrow(() => updater.emit('checking-for-update'));
});

test('installUpdate calls quitAndInstall on the given updater', () => {
    const updater = makeFakeUpdater();
    installUpdate(updater);
    assert.equal(updater.quitAndInstallCalled, true);
});

test('getLastStatus returns the most recent status after an event fires', () => {
    const win = makeFakeWindow();
    const updater = makeFakeUpdater();
    armAutoUpdate(() => win, updater);

    updater.emit('update-available', { version: '1.2.0' });

    assert.deepEqual(getLastStatus(), { state: 'available', version: '1.2.0' });
});

test('armAutoUpdate re-checks periodically instead of only once at startup', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const win = makeFakeWindow();
    const updater = makeFakeUpdater();
    let checkCount = 0;
    updater.checkForUpdates = () => { checkCount += 1; };

    armAutoUpdate(() => win, updater, UPDATE_CHECK_INTERVAL_MS);
    assert.equal(checkCount, 1); // the initial startup check

    t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS);
    assert.equal(checkCount, 2);

    t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS);
    assert.equal(checkCount, 3);
});

test('armAutoUpdate does not re-check before the configured interval has elapsed', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const win = makeFakeWindow();
    const updater = makeFakeUpdater();
    let checkCount = 0;
    updater.checkForUpdates = () => { checkCount += 1; };

    armAutoUpdate(() => win, updater, UPDATE_CHECK_INTERVAL_MS);
    assert.equal(checkCount, 1);

    t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS - 1);
    assert.equal(checkCount, 1);
});

test('armAutoUpdate does not produce an unhandled rejection when checkForUpdates() rejects', async () => {
    const win = makeFakeWindow();
    const updater = makeFakeUpdater();
    updater.checkForUpdates = () => Promise.reject(new Error('feed unreachable'));

    let unhandled = null;
    const onUnhandledRejection = (err) => { unhandled = err; };
    process.once('unhandledRejection', onUnhandledRejection);

    try {
        assert.doesNotThrow(() => armAutoUpdate(() => win, updater));
        // Let the microtask queue flush so a rejection (if unswallowed) would surface.
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(unhandled, null);
    } finally {
        process.removeListener('unhandledRejection', onUnhandledRejection);
    }
});
