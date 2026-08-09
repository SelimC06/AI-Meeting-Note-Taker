import { app, BrowserWindow, screen, ipcMain, desktopCapturer, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { resolveBackendCommand, startBackend, stopBackend, waitForHealth, getBackendLogTail, armCrashMonitor, ensurePortFree } from './backend.js';
import { attemptRecovery, isRecovering } from './backendRecovery.js';
import { armAutoUpdate, getLastStatus, installUpdate } from './updater.js';
import {
    computeRailBounds,
    computeCenteredBounds,
    computeDockSlotScreenRect,
    isPointInRect,
    computeCornerSnap,
    RAIL_WIDTH,
    RAIL_HEIGHT,
    RAIL_GAP,
    RAIL_ERROR_PANEL_HEIGHT,
} from './railGeometry.js';
import { sanitizeCaptureSourceTypes } from './captureSources.js';
import { distReactPath } from './paths.js';
import { shouldPromptBeforeClose, hasActiveJob } from './closeGuard.js';

let railErrorVisible = false;
let isRailFloatDragging = false;
let lastDockSlotClientRect = null;
let railMoveSettleTimer = null;
let railPopOutTimer = null;
let isQuitting = false;

// Last status the rail renderer reported via rail:pushStatus -- lets the
// close/quit guards below know whether a capture is live without having to
// ask the (possibly about-to-be-destroyed) rail window directly.
let lastRailStatus = 'idle';
// Set once the user has confirmed closing (via performGuardedClose below,
// or there was nothing to guard) so the guarded 'close' handler lets a
// second, self-triggered mainWindow.close() through instead of looping.
let closeConfirmed = false;
// Set right before a controlled quit (app:quit's handler, after
// performGuardedClose resolves) explicitly calls app.quit() after
// destroying all windows itself. Destroying the last window also fires
// 'window-all-closed', which normally calls app.quit() on its own --
// without this flag that's a second, redundant app.quit() call.
let quitRequested = false;
// Reentrancy guard so a second close/quit gesture (another click, a rapid
// double-invoke) arriving while performGuardedClose() is already running
// doesn't start a second, overlapping copy of the same recording-guard
// dialog.
let closeInProgress = false;
// Set once before-quit's active-job wait has already run once for this
// quit sequence, so a redundant app.quit() call (see quitRequested above,
// and the belt-and-suspenders reentrancy guard below) doesn't wait twice
// or re-check jobs that already finished.
let quitConfirmed = false;
// Reentrancy guard for before-quit's async wait-for-jobs flow -- in case
// app.quit() is somehow called a second time while it's still resolving.
let beforeQuitInFlight = false;
// Resolved by the rail:stopAndSaveComplete ack below once RailApp's
// stop-triggered upload handoff (or the empty-recording no-op path)
// finishes, so the close/quit guards know when it's actually safe to
// destroy the rail window instead of guessing with a fixed delay.
let pendingStopAck = null;
// Set in before-quit, before anything else -- lets the crash-recovery loop
// (attemptRecovery's isShuttingDown check) abort immediately instead of
// spawning a fresh backend process after the user has already asked to quit.
let shuttingDown = false;
// The port the backend actually ended up bound to (see resolveBackendPort
// below) -- 8000 unless that was held by a foreign process, in which case a
// nearby fallback port was used instead. Threaded into each window's loadFile
// query so the renderer's BACKEND_URL (src/ui/api.ts) points at the right port.
let resolvedBackendPort = null;

// Mirrors the height calculation in the rail:setErrorVisible handler below,
// so the floating window sized during a drag (beginFloatDrag/dragMove)
// accounts for the error panel exactly the same way a stationary resize does.
function currentRailHeight() {
    return railErrorVisible ? RAIL_HEIGHT + RAIL_GAP + RAIL_ERROR_PANEL_HEIGHT : RAIL_HEIGHT;
}

// How long the floating rail's CSS pop-out animation runs for (see
// src/theme.css's .rail-pop-out) — the click-to-reattach handler below waits
// this long before actually hiding the window, so the fade/shrink has time
// to finish first. Unrelated to (and doesn't affect) the drag/corner-snap/
// settle machinery, which never uses this.
const RAIL_POP_OUT_DURATION_MS = 160;

let mainWindow = null;
let railWindow = null;

// Without this, every launch starts a fully independent instance — each with its own
// windows and its own attempt to spawn a backend on the same hardcoded port. If an
// earlier instance never fully quit (e.g. its rail window stayed open, which alone
// keeps Electron's 'window-all-closed' from firing since not every window is closed),
// a new launch's backend collides with the old instance's still-running one.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function disableZoom(webContents) {
    webContents.on('before-input-event', (event, input) => {
        if (input.control && ['=', '-', '0', '+'].includes(input.key)) {
            event.preventDefault();
        }
    });
    if (typeof webContents.setVisualZoomLevelLimits === 'function') {
        webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
    }
}

// Shared by the click-to-reattach button and by settleFloatingRailPosition's
// dock decision below, so "release a drag near the dock slot" and "click
// reattach" look and feel identical — both just play the floating rail's
// .rail-pop-out CSS animation (src/theme.css) in place (no window resize —
// resizing the OS window down to the dock slot's narrower width used to
// visibly clip/crop the rail's fixed-width content mid-animation, which is
// what looked wrong) and hide it once that's done; the dashboard's docked
// pill plays its own .rail-pop-in once 'rail:floatingChanged' flips it back.
function popRailBackToDock() {
    if (!railWindow || railWindow.isDestroyed() || !railWindow.isVisible()) return;
    if (railMoveSettleTimer) {
        clearTimeout(railMoveSettleTimer);
        railMoveSettleTimer = null;
    }
    // Re-entrancy guard: without this, a double-click on the reattach
    // button (or a click racing a drag-release-near-slot) schedules two
    // independent hide+notify timers. If a new float begins between the two
    // firing, the stale second one hides the window that was just re-shown
    // and sends a false floatingChanged:false. Clearing any pending timer
    // before scheduling a new one means only the latest call ever fires.
    if (railPopOutTimer) {
        clearTimeout(railPopOutTimer);
        railPopOutTimer = null;
    }
    railWindow.webContents.send('rail:popState', { popped: true });
    railPopOutTimer = setTimeout(() => {
        railPopOutTimer = null;
        railWindow?.hide();
        mainWindow?.webContents.send('rail:floatingChanged', false);
    }, RAIL_POP_OUT_DURATION_MS);
}

// Converts the cached CLIENT rect into absolute screen coordinates using
// the dashboard's CURRENT bounds, computed fresh on every call rather than
// once at drag-start — otherwise this would go stale if the dashboard
// window moved (not just resized) since the rect was cached.
function currentDockSlotScreenRect() {
    return lastDockSlotClientRect && mainWindow && !mainWindow.isDestroyed()
        ? computeDockSlotScreenRect(mainWindow.getContentBounds(), lastDockSlotClientRect)
        : null;
}

// Decides, once a drag of the floating rail has stopped (either the
// pointer was released at the end of a detach-drag, or an independent
// window-drag of the already-floating rail has settled), whether it
// should dock back into the sidebar or stay floating — snapping to the
// nearest screen edge/corner in the latter case. Shared by both paths so
// "release near the dock slot" behaves identically regardless of which
// gesture produced it.
function settleFloatingRailPosition() {
    if (!railWindow || railWindow.isDestroyed() || !railWindow.isVisible()) return;
    const bounds = railWindow.getBounds();
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const dockSlotScreenRect = currentDockSlotScreenRect();

    if (dockSlotScreenRect && isPointInRect(center, dockSlotScreenRect)) {
        popRailBackToDock();
        return;
    }

    const display = screen.getDisplayNearestPoint(center);
    const snapped = computeCornerSnap(display.workArea, bounds);
    if (snapped.x !== bounds.x || snapped.y !== bounds.y) {
        railWindow.setBounds({ ...bounds, x: snapped.x, y: snapped.y });
    }
    mainWindow?.webContents.send('rail:floatingChanged', true);
}

function resolveRailFile() {
    const prod = distReactPath(app.getAppPath(), 'rail.html');
    if (fs.existsSync(prod)) return prod;
    throw new Error(`rail.html not found at ${prod} - run "npm run build" first`);
}

function computeAndCacheRailBounds(relativeTo) {
  const target = relativeTo || mainWindow;
  if (!target) return null;

  const b = target.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });

  return computeRailBounds(display.workArea, { errorVisible: railErrorVisible });
}

// The rail window is the app's single persistent capture engine: it owns the
// MediaRecorder/mic stream for the lifetime of the app, and nothing ever
// recreates it after startup. It must never be destroyed while the app is
// running — "docked" means hidden, not destroyed (see the 'close' handler
// below, which turns user-close gestures into an implicit dock instead).
function createRailWindow() {
    railWindow = new BrowserWindow({
        show: false,
        frame: false,
        transparent: true,
        useContentSize: true,
        resizable: false,
        movable: true,
        focusable: true,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        titleBarStyle: 'hidden',
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            backgroundThrottling: false,
        },
    });

    // Intercept user-close gestures (Alt+F4, OS close, etc.) — this window has
    // no close button, but it's focusable so OS-level close gestures still
    // reach it. Destroying it would permanently kill the capture engine (see
    // the block comment above), so hide instead, which is also just an
    // implicit dock from the user's perspective. Skipped while the app
    // itself is quitting (isQuitting), so an OS shutdown/logoff — which
    // delivers 'close' to every top-level window — can actually close this
    // one instead of being silently swallowed.
    railWindow.on('close', (e) => {
        if (isQuitting) return;
        e.preventDefault();
        const wasVisible = railWindow.isVisible();
        railWindow.hide();
        // A user-close gesture while floating is functionally a dock, but
        // unlike popRailBackToDock it skips the pop-out animation (the
        // window is already gone) — the dashboard still needs to hear about
        // it, or DockedRail is stuck showing "reattach" for a window that
        // can no longer be reattached to.
        if (wasVisible) {
            mainWindow?.webContents.send('rail:floatingChanged', false);
        }
    });
    railWindow.on('closed', () => {
        if (railMoveSettleTimer) {
            clearTimeout(railMoveSettleTimer);
            railMoveSettleTimer = null;
        }
        if (railPopOutTimer) {
            clearTimeout(railPopOutTimer);
            railPopOutTimer = null;
        }
        railWindow = null;
    });
    // Debounced rather than immediate: 'moved' fires continuously while the
    // user is actively dragging the floating window (via its own
    // -webkit-app-region:drag), and snapping mid-drag would fight the
    // cursor. Waiting for 120ms of no further movement means this only
    // runs once the drag has actually stopped.
    railWindow.on('moved', () => {
        if (isRailFloatDragging) return;
        if (railMoveSettleTimer) clearTimeout(railMoveSettleTimer);
        railMoveSettleTimer = setTimeout(() => {
            railMoveSettleTimer = null;
            settleFloatingRailPosition();
        }, 120);
    });
    disableZoom(railWindow.webContents);

    let railFile;
    try {
        railFile = resolveRailFile();
    } catch (err) {
        console.error('[rail]', err.message);
        railWindow.destroy();
        railWindow = null;
        return;
    }
    railWindow.loadFile(railFile, resolvedBackendPort ? { query: { backendPort: String(resolvedBackendPort) } } : undefined);

    railWindow.webContents.on('did-finish-load', () => {
        const bounds = computeAndCacheRailBounds(mainWindow);
        if (!bounds) return;
        railWindow.setBounds(bounds);
    });
}

ipcMain.handle('rail:setErrorVisible', (_event, visible) => {
    railErrorVisible = !!visible;
    if (!railWindow || railWindow.isDestroyed()) return;
    const current = railWindow.getBounds();
    // Resize in place (preserve x/y) rather than recentering.
    railWindow.setBounds({ x: current.x, y: current.y, width: current.width, height: currentRailHeight() });
});

ipcMain.handle('rail:command', (_event, action) => {
    if (!railWindow || railWindow.isDestroyed()) return;
    railWindow.webContents.send('rail:command', action);
});

ipcMain.handle('rail:pushStatus', (_event, status) => {
    lastRailStatus = status?.status ?? 'idle';
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('rail:status', status);
});

// Acked by RailApp.tsx once a stop triggered by stopAndSaveRailRecording()
// below (the "Stop && Save" dialog choice) has finished its upload handoff
// -- or immediately, on the empty-recording no-op path.
ipcMain.on('rail:stopAndSaveComplete', () => {
    pendingStopAck?.resolve();
});

ipcMain.handle('rail:beginFloatDrag', (_event, slotRect) => {
    if (!mainWindow || mainWindow.isDestroyed() || !railWindow || railWindow.isDestroyed()) return;
    // Set the guard flag and clear any pending settle timer / in-flight
    // animation FIRST, before the setBounds/show() calls below. Those calls
    // can synchronously emit the window's 'moved' event, and if the guard
    // were still false when that happens, the debounced settle listener
    // would schedule a settle that fires ~120ms into this live drag and
    // yanks the rail back into the dock out from under the user.
    isRailFloatDragging = true;
    if (railMoveSettleTimer) {
        clearTimeout(railMoveSettleTimer);
        railMoveSettleTimer = null;
    }
    // A stale pop-out-to-hide timer from a just-finished reattach could
    // otherwise fire mid-way through this brand new float and hide it.
    if (railPopOutTimer) {
        clearTimeout(railPopOutTimer);
        railPopOutTimer = null;
    }
    lastDockSlotClientRect = slotRect;
    const cursor = screen.getCursorScreenPoint();
    railWindow.setBounds(computeCenteredBounds(cursor, RAIL_WIDTH, currentRailHeight()));
    // Doubles as both "reset any leftover pop-out state from a previous
    // click-to-reattach" (the rail renderer isn't reloaded between
    // hide/show, so its faded-out React state would otherwise persist into
    // this new float) and the cue for RailApp to play its own .rail-pop-in
    // entrance — see RailApp.tsx's onRailPopState handling.
    railWindow.webContents.send('rail:popState', { popped: false });
    railWindow.show();
    mainWindow.webContents.send('rail:floatingChanged', true);
});

// Fire-and-forget (ipcRenderer.send, not invoke): dragMove fires once per
// pointermove, and only the latest cursor position ever matters, so there's
// nothing to await and no need to pay for a round-trip reply.
ipcMain.on('rail:dragMove', () => {
    if (!isRailFloatDragging || !railWindow || railWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    railWindow.setBounds(computeCenteredBounds(cursor, RAIL_WIDTH, currentRailHeight()));
});

ipcMain.handle('rail:endFloatDrag', () => {
    isRailFloatDragging = false;
    settleFloatingRailPosition();
});

ipcMain.on('rail:updateDockSlotRect', (_event, slotRect) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    lastDockSlotClientRect = slotRect;
});

ipcMain.handle('rail:getFloating', () => {
    return !!(railWindow && !railWindow.isDestroyed() && railWindow.isVisible());
});

// Click-to-reattach: an explicit, additive alternative to dragging the
// floating rail back near the dock slot. Both paths now converge on the
// same popRailBackToDock() above.
ipcMain.handle('rail:reattach', () => {
    popRailBackToDock();
});

ipcMain.handle("list-capture-sources", async (_event, types) => {
    const sources = await desktopCapturer.getSources({
        types: sanitizeCaptureSourceTypes(types),
        thumbnailSize: { width: 0, height: 0 }, // we only need ids & names
    });

    return sources.map((s) => ({
        id: s.id,
        name: s.name,
    }));
});

ipcMain.handle('dialog:chooseFolder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle('shell:openPrivacySettings', (_event, kind) => {
    const page = kind === 'camera' ? 'ms-settings:privacy-webcam' : 'ms-settings:privacy-microphone';
    shell.openExternal(page).catch(() => {});
});


// Waits for the rail:stopAndSaveComplete ack (see the ipcMain.on handler
// above), or gives up after timeoutMs so a renderer that never acks (crash,
// unexpected error path) can't hang the close/quit flow forever. Generous
// on purpose, not a typical wait: the ack fires only after the full /process
// upload completes (RailApp.tsx), which can take a while for a large
// screen recording -- too short a cap here would destroy the rail window
// mid-upload and silently discard the very recording the user chose to save.
function waitForStopAck(timeoutMs = 120000) {
    return new Promise((resolve) => {
        pendingStopAck = { resolve };
        setTimeout(resolve, timeoutMs);
    }).finally(() => {
        pendingStopAck = null;
    });
}

// Tells the rail to stop -- RailApp.tsx's handleStopForClose handles the
// upload handoff -- and waits for it to finish, so the caller can safely
// destroy windows afterward without discarding the just-stopped capture.
// Deliberately NOT 'toggleRecord': lastRailStatus here is a cached copy of
// the renderer's real status (updated one IPC round-trip behind), so by the
// time this fires it could already be stale. A toggle command trusts
// nothing about current status and would start a brand-new recording
// instead of stopping one if the rail had already gone idle in the
// meantime; 'stopForClose' is a no-op (and acks immediately) when there's
// nothing to stop.
async function stopAndSaveRailRecording() {
    if (!railWindow || railWindow.isDestroyed()) return;
    const acked = waitForStopAck();
    railWindow.webContents.send('rail:command', 'stopForClose');
    await acked;
}

// dialog.showMessageBox's (window, options) and (options) overloads are
// resolved by argument count, not by checking for a nullish first arg -- so
// passing `mainWindow ?? undefined` positionally would break if mainWindow
// is null (e.g. already destroyed by the time before-quit's check runs).
function showMessageBox(options) {
    return mainWindow && !mainWindow.isDestroyed()
        ? dialog.showMessageBox(mainWindow, options)
        : dialog.showMessageBox(options);
}

// Shown by the guarded close/quit paths below when a capture is live.
// Returns true if the user chose to stop & save (and closing should
// proceed), false if they cancelled.
async function confirmCloseWithDialog() {
    const result = await showMessageBox({
        type: 'warning',
        buttons: ['Stop && Save', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Recording in progress',
        message: 'A recording is in progress',
        detail: 'Stop and save the recording before closing, or cancel to keep recording.',
    });
    return result.response === 0;
}

// Shared by the mainWindow 'close' handler and the app:quit IPC handler:
// just the recording guard (Stop && Save / Cancel) -- the active-job wait
// happens later, silently, in before-quit (see waitForActiveJobsToFinish),
// after windows are already gone. Returns true if the close should
// proceed, false if the user cancelled.
async function performGuardedClose() {
    if (shouldPromptBeforeClose(lastRailStatus)) {
        const proceed = await confirmCloseWithDialog();
        if (!proceed) return false;
        await stopAndSaveRailRecording();
    }
    return true;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 450,
        frame: false,
        transparent: true,
        resizable: true,
        webPreferences: {
            devTools: true,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });
    disableZoom(mainWindow.webContents);
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });
    // If the dashboard renderer reloads or crash-recovers mid-drag, its
    // DockedRail component (and whatever pointer state it held) is gone —
    // but isRailFloatDragging is main-process state, so nothing else would
    // ever clear it. Left stuck true, it permanently disables the 'moved'
    // listener's corner-snap and drag-release-to-dock logic for the rest of
    // the app session. Also fires once on the very first load, which is a
    // harmless no-op since both are already at their initial values then.
    mainWindow.webContents.on('did-finish-load', () => {
        isRailFloatDragging = false;
        if (railMoveSettleTimer) {
            clearTimeout(railMoveSettleTimer);
            railMoveSettleTimer = null;
        }
    });
    mainWindow.loadFile(
        distReactPath(app.getAppPath(), 'index.html'),
        resolvedBackendPort ? { query: { backendPort: String(resolvedBackendPort) } } : undefined
    );

    mainWindow.once("ready-to-show", () => {
        if (!app.isPackaged) {
            mainWindow.webContents.openDevTools({ mode: "detach" });
        }
        mainWindow.focus();
    });

    // Cancellable, unlike 'closed' below -- lets us intercept a close
    // gesture (title-bar X, Alt+F4) while a capture is live and ask before
    // the rail window (and its in-memory MediaRecorder buffers) gets
    // destroyed. Skipped once closeConfirmed is set, so the mainWindow.close()
    // call at the end of the guarded flow actually goes through instead of
    // looping back into this same prompt. closeInProgress guards against a
    // second close gesture (or the app:quit IPC handler) starting an
    // overlapping second run while this one is still resolving.
    mainWindow.on('close', (e) => {
        if (isQuitting || closeConfirmed) return;
        if (closeInProgress) {
            e.preventDefault();
            return;
        }
        if (!shouldPromptBeforeClose(lastRailStatus)) return;
        e.preventDefault();
        closeInProgress = true;
        (async () => {
            try {
                const proceed = await performGuardedClose();
                if (!proceed) return;
                closeConfirmed = true;
                mainWindow?.close();
            } finally {
                closeInProgress = false;
            }
        })();
    });

    mainWindow.on('closed', () => {
        if (railWindow && !railWindow.isDestroyed()) {
            railWindow.destroy();
        }
        mainWindow = null;
    });
}

function cpuSnapshot() {
    return os.cpus().map(c => ({ ...c.times }));
}
function cpuPercentFromDelta(prev, curr) {
    let idleDelta = 0, totalDelta = 0;
    for (let i = 0; i < curr.length; i++) {
        const p = prev[i], c = curr[i];
        const idle = c.idle - p.idle;
        const total = (c.user - p.user) + (c.nice - p.nice) + (c.sys - p.sys) + (c.irq - p.irq) + idle;
        idleDelta += idle; totalDelta += total;
    }
    if (totalDelta <= 0) return 0;
    return Math.round((1 - idleDelta / totalDelta) * 100);
}
ipcMain.handle('system:getStats', async () => {
    const before = cpuSnapshot();
    await new Promise(r => setTimeout(r, 150));
    const after = cpuSnapshot();
    const cpuPercent = cpuPercentFromDelta(before, after);
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
    return { cpuPercent, memPercent, totalMemBytes: totalMem, freeMemBytes: freeMem };
});

ipcMain.handle('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.handle('app:quit', async () => {
    // Guards against a second app:quit invocation (a rapid double-click on
    // the close button, or the native 'close' handler above already
    // running) starting an overlapping second guarded-close sequence.
    if (closeInProgress) return;
    closeInProgress = true;
    try {
        const proceed = await performGuardedClose();
        if (!proceed) return;
        // Set before destroying windows, not after -- destroying the last
        // one below synchronously fires 'window-all-closed', which needs
        // to see this flag already set to skip its own app.quit() call.
        quitRequested = true;
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.destroy();
        }
        app.quit();
    } finally {
        closeInProgress = false;
    }
});

const BACKEND_PREFERRED_PORT = 8000;
const BACKEND_MAX_PORTS_TO_TRY = 20;
let BACKEND_URL = null;

let recoveryConfig = null;

// A backend orphaned from a prior launch of *this app* can still hold the preferred port;
// ensurePortFree clears that safely (only killing a PID whose executable matches
// expectedExePath). If the port is instead held by some unrelated process (a user's own dev
// server), it's left alone and this tries the next port up instead of silently killing it.
async function resolveBackendPort(expectedExePath) {
    for (let offset = 0; offset < BACKEND_MAX_PORTS_TO_TRY; offset++) {
        const candidate = BACKEND_PREFERRED_PORT + offset;
        const free = await ensurePortFree(candidate, expectedExePath);
        if (free) return candidate;
    }
    throw new Error(
        `Ports ${BACKEND_PREFERRED_PORT}-${BACKEND_PREFERRED_PORT + BACKEND_MAX_PORTS_TO_TRY - 1} ` +
        'are all in use by other applications.'
    );
}

app.whenReady().then(async () => {
    const projectRoot = app.getAppPath();
    const backend = resolveBackendCommand(projectRoot, process.resourcesPath, app.isPackaged);
    if (!backend) {
        dialog.showErrorBox(
            'Backend not set up',
            'Run `npm run setup:backend` first, then relaunch the app.'
        );
        app.quit();
        return;
    }

    let backendPort;
    try {
        backendPort = await resolveBackendPort(backend.command);
    } catch (err) {
        dialog.showErrorBox('Backend port unavailable', err.message);
        app.quit();
        return;
    }
    resolvedBackendPort = backendPort;
    BACKEND_URL = `http://127.0.0.1:${backendPort}`;

    const backendEnv = {
        ...process.env,
        PORT: String(backendPort),
        ...(app.isPackaged ? {
            APP_DATA_DIR: app.getPath('userData'),
            FFMPEG_BIN: path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'),
            FFPROBE_BIN: path.join(process.resourcesPath, 'ffmpeg', 'ffprobe.exe'),
        } : {}),
    };
    const backendProcess = startBackend(backend.command, backend.args, backend.cwd, backendEnv);

    // Packaged mode gets a longer timeout: a first launch after install can hit
    // slower disk I/O and antivirus scanning of freshly-written files, and the
    // frozen backend's measured cold start (~7.6s) leaves thin margin under 15s.
    // Dev mode launches an already-installed venv python, which is fast and
    // doesn't have this risk, so its timeout stays unchanged.
    const healthTimeoutMs = app.isPackaged ? 30000 : 15000;

    try {
        await waitForHealth(BACKEND_URL, healthTimeoutMs, backendProcess);
    } catch (err) {
        const logTail = getBackendLogTail();
        const detail = logTail
            ? `${err?.message ?? err}\n\nBackend output:\n${logTail}`
            : String(err?.message ?? err);
        dialog.showErrorBox('Backend failed to start', detail);
        await stopBackend();
        app.quit();
        return;
    }

    recoveryConfig = {
        pythonExe: backend.command,
        args: backend.args,
        cwd: backend.cwd,
        env: backendEnv,
        backendUrl: BACKEND_URL,
        logDir: path.join(app.getPath('userData'), 'logs'),
        isShuttingDown: () => shuttingDown,
    };
    armCrashMonitor(backendProcess, (code, signal) => {
        attemptRecovery({ ...recoveryConfig, mainWindow, crashInfo: { exitCode: code, signal } });
    });

    createWindow();
    createRailWindow();
    armAutoUpdate(mainWindow);
});

ipcMain.handle('updater:install', () => installUpdate());
ipcMain.handle('updater:getStatus', () => getLastStatus());

ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('backend:restart', async () => {
    if (!recoveryConfig || isRecovering()) return;
    try {
        const res = await fetch(`${recoveryConfig.backendUrl}/health`);
        if (res.ok) return; // already healthy — don't spawn a second process on the same port
    } catch {
        // not reachable, proceed with recovery
    }
    await attemptRecovery({ ...recoveryConfig, mainWindow, crashInfo: null });
});

// Best-effort check for a still-running transcription job, used only to
// decide whether before-quit below should warn before killing the backend.
// Short-timeouts and swallows errors -- an unreachable/slow backend should
// never block quitting, just skip the warning.
async function fetchActiveJobsForQuitGuard() {
    try {
        const res = await fetch(`${BACKEND_URL}/jobs`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) return [];
        return await res.json();
    } catch {
        return [];
    }
}

const QUIT_JOB_POLL_INTERVAL_MS = 2000;
// A safety cap, not an expected wait -- if a job is somehow still
// queued/running after 5 minutes (stuck backend, huge recording), quitting
// proceeds anyway rather than trapping the user in a windowless app forever.
const QUIT_JOB_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

async function waitForActiveJobsToFinish(timeoutMs = QUIT_JOB_WAIT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const jobs = await fetchActiveJobsForQuitGuard();
        if (!hasActiveJob(jobs)) return;
        await new Promise((resolve) => setTimeout(resolve, QUIT_JOB_POLL_INTERVAL_MS));
    }
}

app.on('before-quit', (e) => {
    // Lets the rail window's 'close' handler distinguish "the user is
    // quitting the whole app / the OS is shutting down" (let it close for
    // real) from "an isolated close gesture aimed at just this window"
    // (Alt+F4 on the rail specifically, which should only hide/dock it).
    // 'before-quit' fires ahead of Electron delivering 'close' to every
    // top-level window, so this is set in time either way -- set
    // unconditionally and immediately, regardless of the guard below.
    isQuitting = true;
    // Set immediately and unconditionally too -- an in-flight recovery attempt
    // (or one that starts between now and the backend actually being stopped
    // below) must never spawn a fresh backend process once quitting has begun.
    shuttingDown = true;

    if (quitConfirmed) {
        // Not awaited deliberately -- this handler doesn't preventDefault here,
        // so Electron proceeds to quit right after this returns. stopBackend's
        // taskkill is still spawned synchronously before that happens, and it
        // runs as its own OS process, so it finishes killing the backend (and
        // its ffmpeg children) independently of whether Electron has already
        // exited by the time it completes.
        stopBackend();
        return;
    }
    if (beforeQuitInFlight) {
        // A previous app.quit() call's wait-for-jobs flow is still
        // resolving -- don't start a second one. Just keep preventing
        // default; the in-flight flow will call app.quit() again once it's
        // done, which re-enters this handler and (with quitConfirmed now
        // true) lets the real quit through.
        e.preventDefault();
        return;
    }
    // Silently let any still-running transcription job finish before the
    // backend gets stopped below -- no dialog, no extra window, it just
    // waits (capped so a stuck job can't trap the app open forever).
    e.preventDefault();
    beforeQuitInFlight = true;
    (async () => {
        try {
            const jobs = await fetchActiveJobsForQuitGuard();
            if (hasActiveJob(jobs)) {
                await waitForActiveJobsToFinish();
            }
        } catch {
            // Proceed with quitting regardless of what went wrong above.
        } finally {
            quitConfirmed = true;
            beforeQuitInFlight = false;
            app.quit();
        }
    })();
});
app.on('window-all-closed', () => {
    if (quitRequested) return; // app:quit's handler already called app.quit() itself
    if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (!mainWindow) createWindow(); });