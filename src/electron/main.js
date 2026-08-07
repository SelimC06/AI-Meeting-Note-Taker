import { app, BrowserWindow, screen, ipcMain, desktopCapturer, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { resolveBackendCommand, startBackend, stopBackend, waitForHealth, getBackendLogTail, armCrashMonitor, ensurePortFree } from './backend.js';
import { attemptRecovery, isRecovering } from './backendRecovery.js';
import { armAutoUpdate, getLastStatus, installUpdate } from './updater.js';
import { computeRailBounds } from './railGeometry.js';
import { computeSlideY, computeOffScreenY, RAIL_SLIDE_DURATION_MS } from './slideAnimation.js';
import { sanitizeCaptureSourceTypes } from './captureSources.js';
import { distReactPath } from './paths.js';

let railErrorVisible = false;

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

function resolveRailFile() {
    const prod = distReactPath(app.getAppPath(), 'rail.html');
    if (fs.existsSync(prod)) return prod;
    throw new Error(`rail.html not found at ${prod} - run "npm run build" first`);
}

let lastWorkArea = null;
let railAnimationTimer = null;
let railPendingComplete = null;

function computeAndCacheRailBounds(relativeTo) {
  const target = relativeTo || mainWindow;
  if (!target) return null;

  const b = target.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  lastWorkArea = display.workArea; // excludes taskbar

  return computeRailBounds(lastWorkArea, { errorVisible: railErrorVisible });
}

// Clears the running interval (if any) and the pending completion, WITHOUT
// invoking the pending completion. This is correct when starting a fresh
// animation that supersedes a previous one (its completion should just be
// abandoned), but callers that are interrupting an in-flight animation to
// finish it early (e.g. because its target window is about to change state)
// must capture railPendingComplete themselves beforehand and invoke it after
// this call, so the completion contract is never silently dropped.
function stopRailAnimation() {
  if (railAnimationTimer) {
    clearInterval(railAnimationTimer);
    railAnimationTimer = null;
  }
  railPendingComplete = null;
}

function animateRailTo(targetY, onComplete) {
  if (!railWindow || railWindow.isDestroyed() || !lastWorkArea) {
    onComplete?.();
    return;
  }
  stopRailAnimation();
  railPendingComplete = onComplete || null;

  const bounds = computeRailBounds(lastWorkArea, { errorVisible: railErrorVisible });
  const startY = railWindow.getBounds().y;
  const startTime = Date.now();

  railAnimationTimer = setInterval(() => {
    if (!railWindow || railWindow.isDestroyed()) {
      const pending = railPendingComplete;
      stopRailAnimation();
      // The window is gone, so there's nothing to .hide() — but the
      // completion contract still needs to be honored (e.g. state
      // bookkeeping in the callback), so invoke it defensively.
      try {
        pending?.();
      } catch (err) {
        console.error('[rail] pending animation completion threw', err);
      }
      return;
    }
    const elapsed = Date.now() - startTime;
    const y = computeSlideY(startY, targetY, elapsed, RAIL_SLIDE_DURATION_MS);
    railWindow.setBounds({ x: bounds.x, y, width: bounds.width, height: bounds.height });

    if (elapsed >= RAIL_SLIDE_DURATION_MS) {
      const pending = railPendingComplete;
      stopRailAnimation();
      pending?.();
    }
  }, 16);
}

function createRailWindow() {
    railWindow = new BrowserWindow({
        show: false,
        frame: false,
        transparent: true,
        useContentSize: true,
        resizable: false,
        movable: false,
        focusable: true,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        titleBarStyle: 'hidden',
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
        },
    });

    railWindow.on('closed', () => {
        stopRailAnimation();
        railWindow = null;
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
        railWindow.setBounds({ x: bounds.x, y: computeOffScreenY(lastWorkArea, bounds), width: bounds.width, height: bounds.height });
        railWindow.show();
        animateRailTo(bounds.y);
    });

    if (!app.isPackaged) {
        railWindow.webContents.openDevTools({ mode: "detach" });
    }
}

function showRail() {
    if (railWindow && !railWindow.isDestroyed()) {
        const bounds = computeAndCacheRailBounds(mainWindow);
        if (bounds) {
            railWindow.setBounds({ x: bounds.x, y: computeOffScreenY(lastWorkArea, bounds), width: bounds.width, height: bounds.height });
        }
        railWindow.show();
        if (bounds) animateRailTo(bounds.y);
        mainWindow?.webContents.send('rail:getState', true);
        return true;
    }
    createRailWindow();
    return true;
}

function hideRail() {
    if (railWindow && !railWindow.isDestroyed() && lastWorkArea) {
        const bounds = computeRailBounds(lastWorkArea, { errorVisible: railErrorVisible });
        const offScreenY = computeOffScreenY(lastWorkArea, bounds);
        animateRailTo(offScreenY, () => {
            railWindow?.hide();
        });
    } else if (railWindow && !railWindow.isDestroyed()) {
        railWindow.hide();
    }
    mainWindow?.webContents.send('rail:getState', false);
    return false;
}

ipcMain.handle('rail:setErrorVisible', (_event, visible) => {
    railErrorVisible = !!visible;
    if (!railWindow || railWindow.isDestroyed() || !lastWorkArea) return;
    const pendingComplete = railPendingComplete;
    stopRailAnimation();
    railWindow.setBounds(computeRailBounds(lastWorkArea, { errorVisible: railErrorVisible }));
    // An interrupted hide-animation's completion (e.g. railWindow.hide()) must
    // still run now that the bounds have been reset to on-screen — otherwise
    // the rail is stuck visible while the rest of the app believes it's hidden.
    pendingComplete?.();
});

ipcMain.handle('rail:toggle', () => {
    if (railWindow && !railWindow.isDestroyed() && railWindow.isVisible()) {
        return hideRail();
    } else {
        return showRail();
    }
});
ipcMain.handle('rail:getState', () => {
    return !!(railWindow && !railWindow.isDestroyed() && railWindow.isVisible());
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
    mainWindow.loadFile(distReactPath(app.getAppPath(), 'index.html'));

    mainWindow.once("ready-to-show", () => {
        if (!app.isPackaged) {
            mainWindow.webContents.openDevTools({ mode: "detach" });
        }
        mainWindow.focus();
    });

    mainWindow.on('closed', () => {
        stopRailAnimation();
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

app.on('before-quit', () => stopBackend());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });