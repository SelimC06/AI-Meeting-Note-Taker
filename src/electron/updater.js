import electronUpdater from 'electron-updater';

const DEFAULT_FEED_URL = 'https://pub-e9fb1382ea6345b5bfcda99097519034.r2.dev';

export function getUpdateFeedUrl(env = process.env) {
    return env.UPDATE_FEED_URL || DEFAULT_FEED_URL;
}

let lastStatus = { state: 'idle' };

export function getLastStatus() {
    return lastStatus;
}

function sendStatus(mainWindow, payload) {
    lastStatus = payload;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:status', payload);
    }
}

// Note: not idempotent — registers listeners on the singleton `updater` with
// no removal, so calling this more than once (with the real electron-updater
// autoUpdater) would attach duplicate listeners. Only called once today, at
// startup, so this is not currently a problem.
export function armAutoUpdate(mainWindow, updater = electronUpdater.autoUpdater) {
    updater.autoDownload = true;
    updater.setFeedURL({ provider: 'generic', url: getUpdateFeedUrl() });

    updater.on('checking-for-update', () => {
        sendStatus(mainWindow, { state: 'checking' });
    });
    updater.on('update-available', (info) => {
        sendStatus(mainWindow, { state: 'available', version: info.version });
    });
    updater.on('update-not-available', () => {
        sendStatus(mainWindow, { state: 'idle' });
    });
    updater.on('download-progress', (progress) => {
        sendStatus(mainWindow, { state: 'downloading', percent: progress.percent });
    });
    updater.on('update-downloaded', (info) => {
        sendStatus(mainWindow, { state: 'ready', version: info.version });
    });
    updater.on('error', (err) => {
        sendStatus(mainWindow, { state: 'error', message: err?.message ?? String(err) });
    });

    // electron-updater's checkForUpdates() both emits 'error' (handled above,
    // which reports it to the renderer) AND rethrows on failure. Swallow the
    // rejection here so a failed check (e.g. an unreachable feed host) doesn't
    // produce an unhandled promise rejection in the main process.
    Promise.resolve(updater.checkForUpdates()).catch(() => {
        // already reported to the renderer via the 'error' listener above
    });
}

export function installUpdate(updater = electronUpdater.autoUpdater) {
    updater.quitAndInstall();
}
