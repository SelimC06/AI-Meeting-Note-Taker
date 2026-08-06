import { app, BrowserWindow, screen, ipcMain, desktopCapturer, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { resolveBackendCommand, startBackend, stopBackend, waitForHealth, getBackendLogTail, armCrashMonitor } from './backend.js';
import { attemptRecovery, isRecovering } from './backendRecovery.js';

let mainWindow = null;
let railWindow = null;

const RAIL_WIDTH = 72;
const RAIL_HEIGHT = 300;
const RAIL_EXPANDED_WIDTH = 300;


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
    const prod = path.join(app.getAppPath() + '/dist-react/rail.html');
    if (fs.existsSync(prod)) return prod;
    throw new Error(`rail.html not found at ${prod} - run "npm run build" first`);
}

function positionRail(relativeTo) {
  const target = relativeTo || mainWindow;
  if (!railWindow || !target) return;

  const b = target.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const wa = display.workArea; // excludes taskbar

  const INSET = 8; // small gap from absolute left

  railWindow.setBounds({
    x: wa.x + INSET,
    y: Math.round(wa.y + (wa.height - RAIL_HEIGHT) / 2),
    width: RAIL_WIDTH,
    height: RAIL_HEIGHT,
  });
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

    railWindow.on('closed', () => (railWindow = null));
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
        positionRail(mainWindow);
        railWindow.show();
    });

    if (!app.isPackaged) {
        railWindow.webContents.openDevTools({ mode: "detach" });
    }
}

function showRail() {
    if (railWindow && !railWindow.isDestroyed()) {
        railWindow.show();
        mainWindow?.webContents.send('rail:getState', true);
        return true;
    }
    createRailWindow();
    return true;
}

function hideRail() {
    if (railWindow && !railWindow.isDestroyed()) {
        railWindow.destroy();
        railWindow = null;
    }
    mainWindow?.webContents.send('rail:getState', false);
    return false;
}

ipcMain.handle('rail:setExpanded', (_event, expanded) => {
    if (!railWindow || railWindow.isDestroyed()) return;
    const bounds = railWindow.getBounds();
    railWindow.setBounds({
        ...bounds,
        width: expanded ? RAIL_EXPANDED_WIDTH : RAIL_WIDTH,
    });
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

ipcMain.handle("list-capture-sources", async (_event, types = ["screen", "window"]) => {
    const sources = await desktopCapturer.getSources({
        types,
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
    mainWindow.loadFile(path.join(app.getAppPath() + '/dist-react/index.html'));

    mainWindow.once("ready-to-show", () => {
        if (!app.isPackaged) {
            mainWindow.webContents.openDevTools({ mode: "detach" });
        }
        mainWindow.focus();
    });

    mainWindow.on('closed', () => (mainWindow = null));
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
});

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