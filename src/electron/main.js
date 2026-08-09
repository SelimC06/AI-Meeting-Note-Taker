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

let railErrorVisible = false;
let isRailFloatDragging = false;
let lastDockSlotClientRect = null;
let railMoveSettleTimer = null;
let railPopOutTimer = null;
let isQuitting = false;

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
    railWindow.loadFile(railFile);

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
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('rail:status', status);
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
    mainWindow.loadFile(distReactPath(app.getAppPath(), 'index.html'));

    mainWindow.once("ready-to-show", () => {
        if (!app.isPackaged) {
            mainWindow.webContents.openDevTools({ mode: "detach" });
        }
        mainWindow.focus();
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
ipcMain.handle('app:quit', () => {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.destroy();
    }
    app.quit();
});

const BACKEND_PORT = '8000';
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

let recoveryConfig = null;

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

    const backendEnv = {
        ...process.env,
        PORT: BACKEND_PORT,
        ...(app.isPackaged ? {
            APP_DATA_DIR: app.getPath('userData'),
            FFMPEG_BIN: path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'),
            FFPROBE_BIN: path.join(process.resourcesPath, 'ffmpeg', 'ffprobe.exe'),
        } : {}),
    };
    // A backend orphaned from a prior launch can still hold this port; clear it
    // before spawning so this launch's health check can't be fooled by a stale process.
    await ensurePortFree(Number(BACKEND_PORT));
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
        stopBackend();
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

app.on('before-quit', () => {
    // Lets the rail window's 'close' handler distinguish "the user is
    // quitting the whole app / the OS is shutting down" (let it close for
    // real) from "an isolated close gesture aimed at just this window"
    // (Alt+F4 on the rail specifically, which should only hide/dock it).
    // 'before-quit' fires ahead of Electron delivering 'close' to every
    // top-level window, so this is set in time either way.
    isQuitting = true;
    stopBackend();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });