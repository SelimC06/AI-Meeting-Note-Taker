import electronUpdater from 'electron-updater';

const DEFAULT_FEED_URL = 'https://updates.deskrecap.com';

export function getUpdateFeedUrl(env = process.env) {
    return env.UPDATE_FEED_URL || DEFAULT_FEED_URL;
}

// A single startup-only check meant the app never learned about a new
// release for the rest of a long-running session.
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// Distinct from 'idle' (a completed check that found no update) -- without
// this, the initial state was indistinguishable from a real "you're on the
// latest version" result, even though no check had run yet.
let lastStatus = { state: 'not-checked' };

export function getLastStatus() {
    return lastStatus;
}

function sendStatus(getMainWindow, payload) {
    lastStatus = payload;
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:status', payload);
    }
}

// Note: not idempotent — registers listeners on the singleton `updater` with
// no removal, so calling this more than once (with the real electron-updater
// autoUpdater) would attach duplicate listeners. Only called once today, at
// startup, so this is not currently a problem.
//
// Takes a getter rather than the window itself: these listeners live for
// the whole app session, while the dashboard window can be recreated
// (macOS Dock reopen) -- a captured reference would keep sending status to
// the dead one and the new dashboard would never hear about an update.
export function armAutoUpdate(getMainWindow, updater = electronUpdater.autoUpdater, checkIntervalMs = UPDATE_CHECK_INTERVAL_MS) {
    updater.autoDownload = true;
    updater.setFeedURL({ provider: 'generic', url: getUpdateFeedUrl() });

    updater.on('checking-for-update', () => {
        sendStatus(getMainWindow, { state: 'checking' });
    });
    updater.on('update-available', (info) => {
        sendStatus(getMainWindow, { state: 'available', version: info.version });
    });
    updater.on('update-not-available', () => {
        sendStatus(getMainWindow, { state: 'idle' });
    });
    updater.on('download-progress', (progress) => {
        sendStatus(getMainWindow, { state: 'downloading', percent: progress.percent });
    });
    updater.on('update-downloaded', (info) => {
        sendStatus(getMainWindow, { state: 'ready', version: info.version });
    });
    updater.on('error', (err) => {
        sendStatus(getMainWindow, { state: 'error', message: err?.message ?? String(err) });
    });

    const check = () => {
        // electron-updater's checkForUpdates() both emits 'error' (handled
        // above, which reports it to the renderer) AND rethrows on failure.
        // Swallow the rejection here so a failed check (e.g. an unreachable
        // feed host) doesn't produce an unhandled promise rejection in the
        // main process.
        Promise.resolve(updater.checkForUpdates()).catch(() => {
            // already reported to the renderer via the 'error' listener above
        });
    };

    check();

    // Periodic re-check: a single startup-only check meant the app never
    // learned about a new release for the rest of a long-running session.
    // unref()'d so this background timer never keeps the process alive on
    // its own -- Electron's window/event system already does that.
    const interval = setInterval(check, checkIntervalMs);
    if (typeof interval.unref === 'function') interval.unref();
    return interval;
}

export function installUpdate(updater = electronUpdater.autoUpdater) {
    updater.quitAndInstall();
}
