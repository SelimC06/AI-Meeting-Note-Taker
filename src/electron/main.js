import { app, BrowserWindow, screen, ipcMain, desktopCapturer } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

let mainWindow = null;
let railWindow = null;


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
}

function positionRail(relativeTo) {
  const target = relativeTo || mainWindow;
  if (!railWindow || !target) return;

  const b = target.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const wa = display.workArea; // excludes taskbar

  const RAIL_WIDTH = 72;
  const RAIL_HEIGHT = 300;
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
    railWindow.loadFile(resolveRailFile());

    railWindow.webContents.on('did-finish-load', () => {
        positionRail(mainWindow);
        railWindow.show();
    });

    railWindow.webContents.openDevTools({ mode: "detach" });
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
    mainWindow.loadFile(path.join(app.getAppPath() + '/dist-react/index.html'));

    mainWindow.once("ready-to-show", () => {
        mainWindow.webContents.openDevTools({ mode: "detach" });
        mainWindow.focus();
    });

    mainWindow.on('closed', () => (mainWindow = null));
}

ipcMain.handle('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.handle('app:quit', () => {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.destroy();
    }
    app.quit();
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });