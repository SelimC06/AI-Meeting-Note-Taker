import electronUpdater from 'electron-updater';
import { getUpdateFeedUrl, WEBSITE_URL } from './updateFeed.js';

export { getUpdateFeedUrl };

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
//
// macOS is check-only. DeskRecap's Mac builds are ad-hoc signed (no Apple
// Developer ID -- see the README), and Squirrel.Mac, which electron-updater
// uses to install on macOS, refuses any update that isn't signed with a
// real Developer ID: downloading it only wastes ~240 MB and ends in a
// signature error, and "restart to update" would do nothing. So on macOS
// nothing is downloaded or installed; a newer version is reported as
// 'manual' with a link to the website to download it from.
export function armAutoUpdate(
    getMainWindow,
    updater = electronUpdater.autoUpdater,
    checkIntervalMs = UPDATE_CHECK_INTERVAL_MS,
    platform = process.platform
) {
    const manualOnly = platform === 'darwin';
    updater.autoDownload = !manualOnly;
    updater.autoInstallOnAppQuit = !manualOnly;
    updater.setFeedURL({ provider: 'generic', url: getUpdateFeedUrl() });

    updater.on('checking-for-update', () => {
        sendStatus(getMainWindow, { state: 'checking' });
    });
    updater.on('update-available', (info) => {
        if (manualOnly) {
            sendStatus(getMainWindow, { state: 'manual', version: info.version, url: WEBSITE_URL });
            return;
        }
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

// How long installUpdateOrQuit gives quitAndInstall to actually start the
// quit before assuming it silently didn't. A real quit is under way well
// before this (quitAndInstall calls app.quit() on the next tick; before-quit
// then spends at most a few seconds stopping the backend), and calling
// app.quit() again during that is harmless.
export const INSTALL_QUIT_FALLBACK_MS = 10000;

// For updater:install, which has already destroyed every window by the
// time it gets here. quitAndInstall() does NOT throw when the installer is
// missing or fails to launch: electron-updater's install() reports it via
// the 'error' event and returns false, and quitAndInstall then just returns
// without quitting -- leaving a windowless, menu-less app the user can't
// quit (and a relaunch only hits the single-instance lock). So quit
// ourselves on the updater's 'error', a synchronous throw, or -- if neither
// comes and the app is still here -- after INSTALL_QUIT_FALLBACK_MS.
export function installUpdateOrQuit(
    quit,
    updater = electronUpdater.autoUpdater,
    fallbackMs = INSTALL_QUIT_FALLBACK_MS
) {
    let settled = false;
    let timer = null;
    const onError = (err) => fallback(err);
    function fallback(reason) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        updater.removeListener?.('error', onError);
        if (reason) console.error('[updater] install failed, quitting without installing:', reason?.message ?? reason);
        quit();
    }
    updater.once('error', onError);
    timer = setTimeout(() => fallback(null), fallbackMs);
    try {
        updater.quitAndInstall();
    } catch (err) {
        fallback(err);
    }
    return timer;
}
