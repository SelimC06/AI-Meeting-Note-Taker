import { app, BrowserWindow, Menu, screen, ipcMain, desktopCapturer, dialog, shell, session } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { resolveBackendCommand, resolveFfmpegPaths, resolveLlamaServerPath, resolveSpeakerModelPath, startBackend, stopBackend, killAllBackendsSync, waitForHealth, getBackendLogTail, armCrashMonitor, ensurePortFree, generateBackendToken, backendAuthHeaders, BACKEND_TOKEN_ENV } from './backend.js';
import { attemptRecovery, isRecovering, statusForHealthyRetry } from './backendRecovery.js';
import { nextWatchdogState, probeHealthOnce, fetchBackendBusy, watchdogThreshold, watchdogBusy, knownBusyAfterRailStatus, WATCHDOG_INTERVAL_MS } from './backendWatchdog.js';
import { isTrustedIpcSender } from './ipcGuard.js';
import { isAllowedPermission } from './permissions.js';
import { armAutoUpdate, getLastStatus, installUpdateOrQuit } from './updater.js';
import {
    computeRailBounds,
    computeRailHeight,
    computeCenteredBounds,
    computeDockSlotScreenRect,
    isPointInRect,
    computeCornerSnap,
    RAIL_WIDTH,
} from './railGeometry.js';
import { computeResizedBounds, isValidResizeDirection } from './resizeGeometry.js';
import { sanitizeCaptureSourceTypes } from './captureSources.js';
import { distReactPath } from './paths.js';
import { needsCloseGuard, hasActiveJob, runInstallShutdownSequence, beforeQuitStep, pendingUploadFromAck, runGuardedClose } from './closeGuard.js';
import { sanitizeRailStatus, isValidSlotRect, isValidRailCommand, sanitizeRailLevel, shouldForwardRailLevel } from './railValidation.js';
import { armProcessCrashLogging, logRendererCrash, logRendererError, safeAppendCrashLog, MAIN_CRASHES_LOG_MAX_BYTES } from './crashLog.js';
import { hasSeenRecordingConsentNotice, markRecordingConsentNoticeSeen } from './consentStore.js';
import { buildAppMenuTemplate, isZoomShortcut } from './appMenu.js';
import { railStatusAfterRendererGone, withCrashNotice, shouldReloadCrashedRenderer, RAIL_CRASH_NOTICE } from './rendererCrash.js';

let railErrorVisible = false;
let railCaptionsVisible = false;
let isRailFloatDragging = false;
let lastDockSlotClientRect = null;
let railMoveSettleTimer = null;
let railPopOutTimer = null;
let mainMoveSettleTimer = null;
// window -> { timer, target } for each in-flight snap slide (see
// animateWindowPosition). Per-window rather than one shared timer, since the
// dashboard and the floating rail can each be mid-snap independently.
const snapAnimations = new Map();
// { direction, startBounds, startCursor } while a dashboard resize-handle
// drag is in progress; null otherwise. Module-level rather than per-call
// because 'window:resizeMove' ticks (see below) need the drag's original
// bounds/cursor position to compute a delta from, not just the latest tick.
let dashboardResizeState = null;

// Stops `window`'s in-flight snap slide, if any, and returns the x/y it was
// heading to (null if nothing was running) -- lets a caller that needs to
// set bounds itself land where the slide would have, instead of wherever
// it happened to be mid-way.
function cancelSnapAnimation(window) {
    const anim = snapAnimations.get(window);
    if (!anim) return null;
    clearInterval(anim.timer);
    snapAnimations.delete(window);
    return anim.target;
}

// Aero Snap's own edge-dock slides the window into place rather than
// teleporting it there; interpolating setBounds calls over a few frames
// gives both the dashboard's and the floating rail's corner-snap that same
// feel. x/y-only (width/height come along unchanged from `bounds`) since
// this only ever runs right after computeCornerSnap, which never touches size.
function animateWindowPosition(window, fromBounds, toXY, durationMs = 140, steps = 8) {
    cancelSnapAnimation(window);
    const { x: fromX, y: fromY, width, height } = fromBounds;
    const deltaX = toXY.x - fromX;
    const deltaY = toXY.y - fromY;
    let step = 0;
    const timer = setInterval(() => {
        step += 1;
        if (!window || window.isDestroyed()) {
            clearInterval(timer);
            snapAnimations.delete(window);
            return;
        }
        const t = Math.min(step / steps, 1);
        const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
        window.setBounds({
            x: Math.round(fromX + deltaX * eased),
            y: Math.round(fromY + deltaY * eased),
            width,
            height,
        });
        if (t >= 1) {
            clearInterval(timer);
            snapAnimations.delete(window);
        }
    }, durationMs / steps);
    snapAnimations.set(window, { timer, target: { x: toXY.x, y: toXY.y } });
}

const MAIN_WINDOW_MIN_WIDTH = 640;
const MAIN_WINDOW_MIN_HEIGHT = 420;
let isQuitting = false;

// Last status the rail renderer reported via rail:pushStatus -- lets the
// close/quit guards below know whether a capture is live without having to
// ask the (possibly about-to-be-destroyed) rail window directly.
let lastRailStatus = 'idle';
// Last isProcessing flag from the same rail:pushStatus payload -- status
// flips back to "idle" as soon as a stopped recording's stop() resolves,
// well before its POST /process upload (still running in the rail
// renderer) actually finishes, so shouldPromptBeforeClose(lastRailStatus)
// alone misses that window entirely. needsCloseGuard() below checks both.
let lastRailIsProcessing = false;
// Last hasPendingUpload flag from the same rail:pushStatus payload -- true
// while a previously FAILED upload's blob is still only held in the rail
// renderer's memory (status back to "idle", isProcessing false), offered
// back via the "retry upload" toast action. Without this, closing here
// proceeded with no guard at all and silently discarded that recording (G3).
let lastRailHasPendingUpload = false;
// The full sanitized last rail:pushStatus payload (not just the three
// booleans above) -- null until the rail's first push. Lets a freshly
// mounted DockedRail pull the CURRENT status instead of sitting on
// DEFAULT_STATUS (which reads "idle"/enabled) for up to ~1s after a
// dashboard reload, during which a stray click on what looks like "Start
// recording" would actually stop a live one (brief 12 #4).
let lastFullRailStatus = null;
// Rail renderer crash handling (see the rail's 'render-process-gone'
// handler): whether its page is currently dead, the crash notice shown in
// the dashboard until the next recording, and when each window was last
// crash-reloaded (to avoid a reload loop).
let railRendererGone = false;
let railCrashNotice = null;
let lastRailCrashReloadAt = null;
let lastMainCrashReloadAt = null;
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
// before-quit's 'finish' step awaits stopBackend() before letting the quit
// through (see there): in flight while that stop runs, stopped once it's
// done and the re-entered quit may proceed.
let backendStopForQuitInFlight = false;
let backendStoppedForQuit = false;
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
// Fresh on every launch and kept only in memory (see backend.js's
// generateBackendToken for why the backend needs it). Deliberately NOT
// threaded through loadFile's query string like the port above: the URL
// ends up in crash logs, devtools and history, the token shouldn't.
// Renderers fetch it over the synchronous backend:getToken IPC in
// preload.js instead.
const backendAuthToken = generateBackendToken();

// Mirrors the height calculation in the rail:set*Visible handlers below,
// so the floating window sized during a drag (beginFloatDrag/dragMove)
// accounts for the error/captions panels exactly the same way a stationary
// resize does.
function currentRailHeight() {
    return computeRailHeight({ errorVisible: railErrorVisible, captionsVisible: railCaptionsVisible });
}

// How long the floating rail's CSS pop-out animation runs for (see
// src/theme.css's .rail-pop-out) — the click-to-reattach handler below waits
// this long before actually hiding the window, so the fade/shrink has time
// to finish first. Unrelated to (and doesn't affect) the drag/corner-snap/
// settle machinery, which never uses this.
const RAIL_POP_OUT_DURATION_MS = 160;

let mainWindow = null;
let railWindow = null;

// Every ipcMain channel below is registered through these two instead of
// ipcMain.on/handle directly:
// - Only this app's own windows' top frames are answered (isTrustedIpcSender
//   -- they only ever load bundled file:// pages); anything else is dropped.
// - An exception thrown by an ipcMain.on listener (fire-and-forget, so
//   there's no caller to hand it back to) used to surface as an
//   uncaughtException, which logs and exits the whole app -- a malformed
//   message could kill a recording. It's logged and swallowed instead.
//   ipcMain.handle already returns a thrown error to the renderer as a
//   rejected invoke(), so handlers only get the sender check.
function trustedIpcSender(event) {
    return isTrustedIpcSender(event, [mainWindow, railWindow]);
}

function ipcOn(channel, listener) {
    ipcMain.on(channel, (event, ...args) => {
        if (!trustedIpcSender(event)) {
            console.warn(`[main] ignored ${channel} from an untrusted sender`);
            return;
        }
        try {
            listener(event, ...args);
        } catch (err) {
            console.error(`[main] ${channel} listener failed:`, err);
            // crashLogDir needs userData, which is only stable once ready.
            if (app.isReady()) {
                // Capped like renderer-errors.log: a renderer can trigger
                // this in a loop, and main-crashes.log must not grow forever.
                safeAppendCrashLog(crashLogDir(), 'main-crashes.log', {
                    kind: 'ipcListenerError',
                    channel,
                    message: err?.message ?? String(err),
                    stack: err?.stack,
                }, { maxBytes: MAIN_CRASHES_LOG_MAX_BYTES });
            }
        }
    });
}

function ipcHandle(channel, handler) {
    ipcMain.handle(channel, (event, ...args) => {
        if (!trustedIpcSender(event)) {
            console.warn(`[main] ignored ${channel} from an untrusted sender`);
            return undefined;
        }
        return handler(event, ...args);
    });
}

// Without this, every launch starts a fully independent instance — each with its own
// windows and its own attempt to spawn a backend on the same hardcoded port. If an
// earlier instance never fully quit (e.g. its rail window stayed open, which alone
// keeps Electron's 'window-all-closed' from firing since not every window is closed),
// a new launch's backend collides with the old instance's still-running one.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    // exit, not quit: app.quit() is asynchronous and still let this
    // module's whenReady callback run -- which calls ensurePortFree, and
    // that kills any process on the backend port whose executable matches
    // ours: the FIRST instance's live backend. whenReady also bails on
    // !gotSingleInstanceLock below, in case exit hasn't landed yet.
    app.exit(0);
} else {
    app.on('second-instance', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            // On macOS the dashboard may only be hidden (see its 'close'
            // handler), and focus() alone doesn't bring a hidden window back.
            mainWindow.show();
            mainWindow.focus();
            return;
        }
        // No dashboard at all (e.g. windows destroyed by a quit sequence
        // that then didn't finish): relaunching is the user's only way back
        // in, and it lands here because of the single-instance lock -- so
        // recreate the windows, same as a macOS Dock click does.
        reopenWindows();
    });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function disableZoom(webContents) {
    webContents.on('before-input-event', (event, input) => {
        if (isZoomShortcut(input, process.platform)) {
            event.preventDefault();
        }
    });
    if (typeof webContents.setVisualZoomLevelLimits === 'function') {
        webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
    }
}

// Hardening only, applied to both windows: each one loads its own bundled
// HTML file via loadFile() exactly once and does all "navigation"
// client-side (React state, no real page loads) -- there is no legitimate
// reason for a real top-level navigation to ever happen afterward. Without
// this, a compromised/malicious renderer (or a stray link, window.location
// assignment, etc.) could navigate the window away to attacker-controlled
// content. External links are handled separately via setWindowOpenHandler.
//
// A plain <a href="https://..."> without target="_blank" goes through here
// rather than setWindowOpenHandler, and used to be blocked silently -- the
// link just did nothing. http(s) targets open in the system browser, same
// as window.open; the navigation itself is still always prevented.
function preventNavigation(webContents) {
    webContents.on('will-navigate', (event, url) => {
        event.preventDefault();
        if (/^https?:\/\//.test(url)) {
            shell.openExternal(url).catch(() => {});
        }
    });
}

// Denies opening a new window/tab; https(s) links are handed off to the
// system browser instead of ever loading inside this app.
function denyWindowOpenExceptExternalHttp(webContents) {
    webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });
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
    cancelSnapAnimation(railWindow);
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
// Also null while the dashboard is hidden (macOS Cmd+W, see its 'close'
// handler): its bounds still exist, but "docking" the floating rail into an
// invisible slot would make a live recording's only visible controls vanish.
function currentDockSlotScreenRect() {
    return lastDockSlotClientRect && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
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
    if (!railWindow || railWindow.isDestroyed() || !railWindow.isVisible()) {
        // The rail is missing/destroyed/hidden right at the moment a drag
        // released -- definitionally not floating. Without this push,
        // DockedRail's isSettling(true) (set on drag-release) never clears,
        // since it only clears on a 'rail:floatingChanged' push, leaving the
        // docked pill permanently disabled until the user re-detaches it
        // (re-review-12-13 H3).
        mainWindow?.webContents.send('rail:floatingChanged', false);
        return;
    }
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
        animateWindowPosition(railWindow, bounds, snapped);
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

  return computeRailBounds(display.workArea, {
    errorVisible: railErrorVisible,
    captionsVisible: railCaptionsVisible,
  });
}

// The rail window is the app's single persistent capture engine: it owns the
// MediaRecorder/mic stream for the lifetime of the app. The only thing that
// recreates it after startup is macOS's 'activate' (Dock click), as a
// safety net if it's somehow gone. It must never be destroyed while the app is
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
        // Deliberately no titleBarStyle: on macOS 'hidden' hides the title bar
        // but KEEPS the standard traffic-light controls (close/minimize/zoom),
        // which is exactly what it did here -- painting them over a floating
        // rail that is supposed to be chromeless, and offering a close button
        // for a window whose 'close' handler only hides it anyway. `frame:
        // false` above already removes all window chrome on every platform,
        // and on Windows 'hidden' without a titleBarOverlay adds nothing over
        // it, so dropping this is a no-op there.
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            backgroundThrottling: false,
            devTools: !app.isPackaged,
        },
    });

    // Belt and braces for macOS: even frameless windows can be given the
    // traffic lights back by other config, and this rail must never show them.
    if (process.platform === 'darwin' && typeof railWindow.setWindowButtonVisibility === 'function') {
        railWindow.setWindowButtonVisibility(false);
    }

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
    // Captured rather than read off railWindow in 'closed', which runs after
    // the window is destroyed and railWindow may already be reassigned.
    const thisRailWindow = railWindow;
    railWindow.on('closed', () => {
        cancelSnapAnimation(thisRailWindow);
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
    // The rail window hosts the actual recording engine -- if its renderer
    // process dies outright (OOM kill, GPU crash) rather than just throwing
    // a catchable JS error, a live capture is lost with nothing to say why.
    //
    // Recovered, not just logged: main otherwise kept its last cached rail
    // state forever -- 'recording', so every close asked to "Stop & Save" a
    // recording that no longer existed, sent stopForClose to a dead page and
    // hung 120s on the ack; the watchdog stayed on its patient busy
    // threshold; and nothing could record again until a relaunch.
    railWindow.webContents.on('render-process-gone', (_event, details) => {
        logRendererCrash(crashLogDir(), { window: 'rail', reason: details.reason, exitCode: details.exitCode });
        if (isQuitting) return;
        handleRailRendererGone();
    });
    railWindow.webContents.on('did-finish-load', () => {
        railRendererGone = false;
    });
    // Debounced rather than immediate: 'moved' fires continuously while the
    // user is actively dragging the floating window (via its own
    // -webkit-app-region:drag), and snapping mid-drag would fight the
    // cursor. 450ms of stillness, not 120: Electron gives no mouse-button
    // state during a native window drag, so stillness is the only release
    // signal there is -- and at 120ms, merely pausing mid-hold near an
    // edge yanked the rail out of the user's hand. A natural mid-drag
    // pause survives 450ms; after a real release the extra wait is
    // imperceptible (the snap happens while nobody is touching anything).
    railWindow.on('moved', () => {
        // The snap slide's own setBounds ticks fire 'moved' too -- they're
        // the result of a settle, not a new user drag to settle.
        if (isRailFloatDragging || snapAnimations.has(railWindow)) return;
        if (railMoveSettleTimer) clearTimeout(railMoveSettleTimer);
        railMoveSettleTimer = setTimeout(() => {
            railMoveSettleTimer = null;
            settleFloatingRailPosition();
        }, 450);
    });
    disableZoom(railWindow.webContents);
    preventNavigation(railWindow.webContents);
    denyWindowOpenExceptExternalHttp(railWindow.webContents);

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

// Shared by the error-toast and live-captions panel toggles: resize the
// rail window in place (preserve x/y) to whatever the current panel set
// needs.
function resizeRailForPanels() {
    if (!railWindow || railWindow.isDestroyed()) return;
    // A snap slide still in flight would keep resetting the old height on
    // every tick -- stop it and resize at the spot it was heading to.
    const snapTarget = cancelSnapAnimation(railWindow);
    const current = railWindow.getBounds();
    railWindow.setBounds({
        x: snapTarget?.x ?? current.x,
        y: snapTarget?.y ?? current.y,
        width: current.width,
        height: currentRailHeight(),
    });
}

ipcHandle('rail:setErrorVisible', (_event, visible) => {
    railErrorVisible = !!visible;
    resizeRailForPanels();
});

ipcHandle('rail:setCaptionsVisible', (_event, visible) => {
    railCaptionsVisible = !!visible;
    resizeRailForPanels();
});

ipcHandle('rail:command', (_event, action) => {
    if (!isValidRailCommand(action)) {
        console.warn('[main] dropped unknown rail:command:', action);
        return;
    }
    if (!railWindow || railWindow.isDestroyed()) return;
    railWindow.webContents.send('rail:command', action);
});

function handleRailRendererGone() {
    railRendererGone = true;
    const reset = railStatusAfterRendererGone();
    railCrashNotice = RAIL_CRASH_NOTICE;
    lastFullRailStatus = reset;
    lastRailStatus = reset.status;
    lastRailIsProcessing = reset.isProcessing;
    lastRailHasPendingUpload = reset.hasPendingUpload;
    // A close/quit waiting on this page's ack would otherwise sit out the
    // full 120s timeout -- the page that would ack is gone, and so is
    // anything it could have saved (hence hasPendingUpload: false).
    pendingStopAck?.resolve({ hasPendingUpload: false });
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('rail:status', reset);
    }
    if (railWindow && !railWindow.isDestroyed() && shouldReloadCrashedRenderer(lastRailCrashReloadAt)) {
        lastRailCrashReloadAt = Date.now();
        railWindow.webContents.reload();
    }
}

ipcHandle('rail:pushStatus', (_event, status) => {
    const parsed = sanitizeRailStatus(status);
    if (!parsed) {
        console.warn('[main] dropped malformed rail:pushStatus payload:', status);
        return;
    }
    // The crash notice stays up after the reloaded rail starts pushing its
    // own idle status, until a new recording starts.
    if (parsed.status !== 'idle') railCrashNotice = null;
    const sanitized = withCrashNotice(parsed, railCrashNotice);
    lastFullRailStatus = sanitized;
    lastRailStatus = sanitized.status;
    backendKnownBusy = knownBusyAfterRailStatus(backendKnownBusy, lastRailIsProcessing, sanitized.isProcessing);
    lastRailIsProcessing = sanitized.isProcessing;
    lastRailHasPendingUpload = sanitized.hasPendingUpload;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('rail:status', sanitized);
});

// Live level-meter samples from the rail (~every 60ms while recording),
// forwarded to the dashboard's docked meter only while it's on screen -- see
// sanitizeRailLevel/shouldForwardRailLevel. Fire-and-forget both ways (no
// invoke round trip), and only accepted from the rail's own page.
ipcOn('rail:level', (event, level) => {
    if (!railWindow || railWindow.isDestroyed() || event.sender !== railWindow.webContents) return;
    const sanitized = sanitizeRailLevel(level);
    if (!sanitized || !mainWindow || mainWindow.isDestroyed()) return;
    const forward = shouldForwardRailLevel({
        railVisible: railWindow.isVisible(),
        dashboardVisible: mainWindow.isVisible(),
        dashboardMinimized: mainWindow.isMinimized(),
    });
    if (forward) mainWindow.webContents.send('rail:level', sanitized);
});

// Pull side of the same pull+push handshake used for backend:status (see
// backend:getStatus) -- a freshly mounted DockedRail (e.g. after a
// dashboard reload) has no way to learn the CURRENT status other than
// waiting for the next push, which can be ~1s away (RailApp's elapsed-time/
// level ticks). Until then it would sit on DEFAULT_STATUS, which reads
// "idle" and leaves the Record button enabled -- one click during that
// window would send toggleRecord and stop an actually-live recording.
ipcHandle('rail:getStatus', () => lastFullRailStatus);

// Acked by RailApp.tsx once a stop triggered by stopAndSaveRailRecording()
// below (the "Stop && Save" dialog choice) has finished its upload handoff
// -- or immediately, on the empty-recording no-op path.
// Carries { hasPendingUpload } read at ack time -- see waitForStopAck.
ipcOn('rail:stopAndSaveComplete', (_event, payload) => {
    pendingStopAck?.resolve(payload);
});

ipcHandle('rail:beginFloatDrag', (_event, slotRect) => {
    if (!mainWindow || mainWindow.isDestroyed() || !railWindow || railWindow.isDestroyed()) return;
    if (!isValidSlotRect(slotRect)) {
        console.warn('[main] dropped malformed slotRect in rail:beginFloatDrag:', slotRect);
        return;
    }
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
    // Likewise a snap slide left over from the previous float would keep
    // pulling the window away from the cursor.
    cancelSnapAnimation(railWindow);
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
ipcOn('rail:dragMove', () => {
    if (!isRailFloatDragging || !railWindow || railWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    railWindow.setBounds(computeCenteredBounds(cursor, RAIL_WIDTH, currentRailHeight()));
});

ipcHandle('rail:endFloatDrag', () => {
    isRailFloatDragging = false;
    settleFloatingRailPosition();
});

ipcOn('rail:updateDockSlotRect', (_event, slotRect) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!isValidSlotRect(slotRect)) {
        console.warn('[main] dropped malformed slotRect in rail:updateDockSlotRect:', slotRect);
        return;
    }
    // null is DockedRail explicitly disabling the dock slot while the
    // sidebar is collapsed -- currentDockSlotScreenRect() already treats a
    // falsy lastDockSlotClientRect as "no valid slot", so this alone is
    // enough to stop a drop from hit-testing against stale (now-hidden)
    // coordinates (brief 12 #1).
    lastDockSlotClientRect = slotRect;
});

ipcHandle('rail:getFloating', () => {
    return !!(railWindow && !railWindow.isDestroyed() && railWindow.isVisible());
});

// Click-to-reattach: an explicit, additive alternative to dragging the
// floating rail back near the dock slot. Both paths now converge on the
// same popRailBackToDock() above.
ipcHandle('rail:reattach', () => {
    popRailBackToDock();
});

ipcHandle("list-capture-sources", async (_event, types) => {
    const sources = await desktopCapturer.getSources({
        types: sanitizeCaptureSourceTypes(types),
        thumbnailSize: { width: 0, height: 0 }, // we only need ids & names
    });

    return sources.map((s) => ({
        id: s.id,
        name: s.name,
    }));
});

ipcHandle('dialog:chooseFolder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcHandle('shell:openPrivacySettings', (_event, kind) => {
    const page = process.platform === 'darwin'
        ? (kind === 'screenRecording'
            ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
            : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
        : (kind === 'camera' ? 'ms-settings:privacy-webcam' : 'ms-settings:privacy-microphone');
    shell.openExternal(page).catch(() => {});
});

// Called from RailApp.tsx right before it actually starts a recording --
// the single choke point both a direct click on the rail's own button and a
// remote toggleRecord command (relayed from DockedRail.tsx in the
// dashboard) already funnel through. The very first time ever, this shows a
// one-time notice in the dashboard window and blocks the recording on the
// user's response; every time after that it resolves true immediately with
// no round trip. If mainWindow doesn't exist for some reason, fails open
// (resolves true) -- this is a reminder, not an access-control gate, and
// silently blocking recording forever with nowhere to show the notice would
// be worse than skipping it.
const consentFilePath = () => path.join(app.getPath('userData'), 'consent.json');

// A single shared in-flight promise instead of a fresh ipcMain.once per
// call: without this, a second ensureRecordingConsent() invocation while
// the first is still awaiting the modal (nothing disables the Record button
// during that wait) registers a SECOND once-listener, and Node's
// EventEmitter fires every listener on one emit -- both invocations resolve
// together and both proceed to record() concurrently.
let pendingConsentResolve = null;

ipcHandle('consent:ensureRecordingConsent', async () => {
    if (hasSeenRecordingConsentNotice(consentFilePath())) return true;
    if (!mainWindow || mainWindow.isDestroyed()) return true;

    if (pendingConsentResolve) {
        // Already showing/awaiting the notice for an earlier call -- wait on
        // that same decision instead of showing a second dialog.
        return new Promise((resolve) => {
            const prev = pendingConsentResolve;
            pendingConsentResolve = (value) => { prev(value); resolve(value); };
        });
    }

    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('consent:showRecordingNotice');

    const proceed = await new Promise((resolve) => {
        pendingConsentResolve = resolve;
    });
    pendingConsentResolve = null;
    if (proceed) markRecordingConsentNoticeSeen(consentFilePath());
    return proceed;
});

ipcOn('consent:recordingNoticeResponse', (_event, value) => {
    pendingConsentResolve?.(value === true);
});

// The notice lives in the dashboard renderer's React state. If that page
// reloads (or its renderer dies) while the notice is up, the notice is gone
// and no response will ever come -- the pending ensureRecordingConsent, and
// the recording start awaiting it, used to hang forever. Settled as "don't
// proceed": the user never actually saw it through, and the next Record
// click simply shows the notice again. (A closed dashboard still fails open
// instead -- see mainWindow's 'closed' handler and the comment above.)
function cancelPendingConsentNotice() {
    pendingConsentResolve?.(false);
    pendingConsentResolve = null;
}

// Reports a JS error caught in a renderer (window.onerror /
// unhandledrejection, wired up in src/ui/main.tsx and src/rail/main.tsx) --
// the renderer process is still alive here, unlike render-process-gone
// above, but this is the far more common failure mode for a React UI (a
// broken/blank screen) than an actual process death.
// Validated, size-capped and rotated inside logRendererError, and a failed
// write is logged rather than thrown (see crashLog.js) -- this used to
// destructure whatever arrived and could throw straight out of the listener.
ipcOn('diagnostics:reportRendererError', (_event, payload) => {
    logRendererError(crashLogDir(), payload);
});

// Everything logged above (main-crashes.log, renderer-crashes.log,
// renderer-errors.log) and the backend's own backend-crashes.log all land in
// this same folder -- this is the only way to get at them, by design: they
// stay on-device unless the user chooses to open and share this folder
// themselves, the same local-only stance as the rest of the app.
ipcHandle('diagnostics:openLogsFolder', async () => {
    const dir = crashLogDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
});

// Settings > About > Third-party notices. Packaged builds ship the file as
// an extraResource; a dev run reads the repo's copy. Opened with the OS's
// default viewer for .md files (a text editor at worst) -- it's a long legal
// document, not something to render inside the settings screen.
ipcHandle('about:openThirdPartyNotices', async () => {
    const file = app.isPackaged
        ? path.join(process.resourcesPath, 'THIRD_PARTY_NOTICES.md')
        : path.join(app.getAppPath(), 'THIRD_PARTY_NOTICES.md');
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
});


// Waits for the rail:stopAndSaveComplete ack (see the ipcMain.on handler
// above), or gives up after timeoutMs so a renderer that never acks (crash,
// unexpected error path) can't hang the close/quit flow forever. Generous
// on purpose, not a typical wait: the ack fires only after the full /process
// upload completes (RailApp.tsx), which can take a while for a large
// screen recording -- too short a cap here would destroy the rail window
// mid-upload and silently discard the very recording the user chose to save.
//
// The ack's payload refreshes lastRailHasPendingUpload before anything
// awaiting this reads it: the rail:pushStatus copy lags a re-render behind
// the ack, so after a stop-for-close upload that just FAILED it would still
// read false, and performGuardedClose would skip the Retry/Discard dialog
// and destroy the only copy of that recording. A timeout (no payload)
// keeps the cached value -- see pendingUploadFromAck.
function waitForStopAck(timeoutMs = 120000) {
    let timer;
    return new Promise((resolve) => {
        pendingStopAck = { resolve };
        timer = setTimeout(resolve, timeoutMs);
    }).then((payload) => {
        lastRailHasPendingUpload = pendingUploadFromAck(payload, lastRailHasPendingUpload);
    }).finally(() => {
        clearTimeout(timer);
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
    if (!railWindow || railWindow.isDestroyed() || railRendererGone) return;
    const acked = waitForStopAck();
    railWindow.webContents.send('rail:command', 'stopForClose');
    await acked;
}

// Tells the rail to retry a previously failed upload (RailApp.tsx's
// handleRetryUploadForClose) and waits for it to finish, the same
// ack-based handoff stopAndSaveRailRecording uses -- reuses waitForStopAck
// since it's the same rail:stopAndSaveComplete channel either way.
async function retryRailUploadAndWait() {
    if (!railWindow || railWindow.isDestroyed() || railRendererGone) return;
    const acked = waitForStopAck();
    railWindow.webContents.send('rail:command', 'retryUploadForClose');
    await acked;
}

// dialog.showMessageBox's (window, options) and (options) overloads are
// resolved by argument count, not by checking for a nullish first arg -- so
// passing `mainWindow ?? undefined` positionally would break if mainWindow
// is null (e.g. already destroyed by the time before-quit's check runs).
// The dashboard is shown first because on macOS it may only be hidden
// (Cmd+W), and a sheet attached to a hidden window is invisible -- a Dock
// "Quit" or Cmd+Q would then wait forever on a dialog nobody can see. The
// app is also brought to the front, since a Dock "Quit" or a logout
// doesn't activate it.
function showMessageBox(options) {
    if (process.platform === 'darwin') app.focus({ steal: true });
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (!mainWindow.isVisible()) mainWindow.show();
        return dialog.showMessageBox(mainWindow, options);
    }
    return dialog.showMessageBox(options);
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

// Shown by the guarded close/quit paths below when a previously failed
// upload's blob is still only held in the rail renderer's memory (G3).
// Unlike confirmCloseWithDialog, there's no "keep the app open" option here
// -- closing is going ahead either way; this only decides whether to wait
// out one more retry attempt first or just let the blob go.
async function confirmPendingUploadDialog() {
    const result = await showMessageBox({
        type: 'warning',
        buttons: ['Retry and wait', 'Discard and close'],
        defaultId: 0,
        cancelId: 1,
        title: 'Recording not uploaded',
        message: "A recording hasn't been uploaded yet",
        detail: 'One or more recordings failed to upload and are only held in memory. Retry and wait for them to finish, or discard them and close now.',
    });
    return result.response === 0 ? 'retry' : 'discard';
}

// Shared by the mainWindow 'close' handler and the app:quit IPC handler:
// just the recording guard (Stop && Save / Cancel) -- the active-job wait
// happens later, silently, in before-quit (see waitForActiveJobsToFinish),
// after windows are already gone. Returns true if the close should
// proceed, false if the user cancelled.
async function performGuardedClose() {
    // Everything guarded below lives only in the rail renderer -- once that
    // window is gone there's nothing left to save, and lastRail* are just
    // stale copies of its last push (e.g. a discarded pending upload), which
    // would otherwise re-prompt on the quit that follows a guarded close.
    // A rail whose renderer died counts as gone too: its recording and any
    // pending upload died with it, and it can't answer a stop anyway.
    if (!railWindow || railWindow.isDestroyed() || railRendererGone) return true;
    return runGuardedClose({
        railStatus: lastRailStatus,
        isProcessing: lastRailIsProcessing,
        // Read lazily, after stopAndSave's ack has refreshed it.
        hasPendingUpload: () => lastRailHasPendingUpload,
        confirmClose: confirmCloseWithDialog,
        stopAndSave: stopAndSaveRailRecording,
        confirmPendingUpload: confirmPendingUploadDialog,
        retryUpload: retryRailUploadAndWait,
    });
}

// Hiding a fullscreen window on macOS leaves a black, empty Space behind,
// so leave fullscreen first and hide once that transition has finished.
function hideMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isFullScreen()) {
        mainWindow.once('leave-full-screen', () => mainWindow?.hide());
        mainWindow.setFullScreen(false);
        return;
    }
    mainWindow.hide();
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 450,
        minWidth: MAIN_WINDOW_MIN_WIDTH,
        minHeight: MAIN_WINDOW_MIN_HEIGHT,
        frame: false,
        transparent: true,
        resizable: true,
        webPreferences: {
            // Off in packaged builds: DevTools on a recording app's renderer
            // is both a reload button (losing the capture) and a way into
            // the backend auth token. Dev keeps it for debugging.
            devTools: !app.isPackaged,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });
    disableZoom(mainWindow.webContents);
    preventNavigation(mainWindow.webContents);
    denyWindowOpenExceptExternalHttp(mainWindow.webContents);
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        logRendererCrash(crashLogDir(), { window: 'main', reason: details.reason, exitCode: details.exitCode });
        cancelPendingConsentNotice();
        // A frameless window with a dead renderer is a blank rectangle with
        // no close button -- reload it (not in a loop, see
        // shouldReloadCrashedRenderer).
        if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
        if (shouldReloadCrashedRenderer(lastMainCrashReloadAt)) {
            lastMainCrashReloadAt = Date.now();
            mainWindow.webContents.reload();
        }
    });
    // Fires for a reload (Ctrl+R, crash-recovery reload); on the very first
    // load nothing is pending yet, so it's a no-op then.
    mainWindow.webContents.on('did-start-loading', cancelPendingConsentNotice);
    // If the dashboard renderer reloads or crash-recovers mid-drag, its
    // DockedRail component (and whatever pointer state it held) is gone —
    // but isRailFloatDragging is main-process state, so nothing else would
    // ever clear it. Left stuck true, it permanently disables the 'moved'
    // listener's corner-snap and drag-release-to-dock logic for the rest of
    // the app session. Also fires once on the very first load, which is a
    // harmless no-op since both are already at their initial values then.
    // dashboardResizeState is the exact same failure mode, one level up: a
    // reload mid-resize leaves ResizeHandles.tsx's own pointer state gone
    // too, with nothing left to ever call window:endResize -- left stuck
    // set, the 'moved' guard above would then permanently disable corner-
    // snap the same way a stuck isRailFloatDragging would.
    mainWindow.webContents.on('did-finish-load', () => {
        isRailFloatDragging = false;
        if (railMoveSettleTimer) {
            clearTimeout(railMoveSettleTimer);
            railMoveSettleTimer = null;
        }
        dashboardResizeState = null;
        if (mainMoveSettleTimer) {
            clearTimeout(mainMoveSettleTimer);
            mainMoveSettleTimer = null;
        }
        // Belt-and-braces alongside backend:getStatus (called on mount by
        // useBackendLifecycle): a fresh load/reload's listener can still
        // miss a status sent in the same tick as this event, so re-push
        // whatever we last sent once the renderer is definitely ready.
        if (lastBackendStatus && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('backend:status', lastBackendStatus);
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

    // A native -webkit-app-region:drag move is a genuine OS modal move loop
    // on Windows (the same one a real title bar uses) -- Windows itself owns
    // the mouse for its whole duration, which means the button-up that ends
    // it is consumed by Windows and never reaches the page as a DOM 'mouseup'
    // event. There's no distinct "drag ended" event to listen for at all, so
    // -- same as the rail's own further-dragging just above -- debounce to
    // the trailing edge of 'moved': while actively dragging, Windows fires
    // 'moved' continuously (comfortably faster than this 120ms window), so
    // the timer only ever actually elapses once the drag has genuinely
    // stopped (paused or released). A drag that merely passes near an edge
    // without pausing there is unaffected.
    mainWindow.on('moved', () => {
        // A 'w'/'n'/'nw'/'ne'/'sw' resize handle shifts x/y to keep the
        // opposite edge anchored (see computeResizedBounds), which fires
        // this same 'moved' event -- without this guard, resizing a window
        // that ends up near a screen edge could get its position yanked to
        // that edge out from under the still-in-progress resize, the same
        // failure mode isRailFloatDragging guards against just above.
        if (dashboardResizeState) return;
        if (mainMoveSettleTimer) clearTimeout(mainMoveSettleTimer);
        mainMoveSettleTimer = setTimeout(() => {
            mainMoveSettleTimer = null;
            if (!mainWindow || mainWindow.isDestroyed()) return;
            const bounds = mainWindow.getBounds();
            const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
            // allowOffScreen: unlike the rail (which should always be fully
            // reachable), the dashboard needs to stay draggable half off-
            // screen on purpose -- see computeCornerSnap's own comment.
            // Threshold 8 (the geometry default): only attach when the
            // window is basically on the edge, not merely near it.
            const snapped = computeCornerSnap(display.workArea, bounds, 8, { allowOffScreen: true });
            if (snapped.x !== bounds.x || snapped.y !== bounds.y) {
                animateWindowPosition(mainWindow, bounds, snapped);
            }
            // 450ms of stillness, same reasoning as the rail's settle
            // listener: stillness is the only release signal available
            // for a native drag, and 120ms treated a mid-hold pause as
            // "let go".
        }, 450);
    });

    // Cancellable, unlike 'closed' below -- lets us intercept a close
    // gesture (title-bar X, Alt+F4) while a capture is live, or its
    // just-stopped recording is still uploading, and guard before the rail
    // window (and its in-memory MediaRecorder buffers / in-flight upload)
    // gets destroyed. Skipped once closeConfirmed is set, so the
    // mainWindow.close() call at the end of the guarded flow actually goes
    // through instead of looping back into this same prompt. closeInProgress
    // guards against a second close gesture (or the app:quit IPC handler)
    // starting an overlapping second run while this one is still resolving.
    //
    // On macOS the app outlives its windows, so closing the dashboard
    // (Cmd+W, Window > Close) only hides it instead: destroying it used to
    // take the rail -- the app's one capture engine, see createRailWindow --
    // down with it (see 'closed' below), leaving a Dock-reopened dashboard
    // that could never record again until a relaunch. Hiding loses nothing,
    // so no recording guard is needed on that path; a real quit tears
    // windows down via destroy() (runGuardedQuit) or with isQuitting set.
    mainWindow.on('close', (e) => {
        if (isQuitting || closeConfirmed) return;
        if (process.platform === 'darwin') {
            e.preventDefault();
            hideMainWindow();
            return;
        }
        if (closeInProgress) {
            e.preventDefault();
            return;
        }
        if (!needsCloseGuard(lastRailStatus, lastRailIsProcessing, lastRailHasPendingUpload)) return;
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
        if (mainMoveSettleTimer) {
            clearTimeout(mainMoveSettleTimer);
            mainMoveSettleTimer = null;
        }
        cancelSnapAnimation(mainWindow);
        dashboardResizeState = null;
        pendingConsentResolve?.(true);
        pendingConsentResolve = null;
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
ipcHandle('system:getStats', async () => {
    const before = cpuSnapshot();
    await new Promise(r => setTimeout(r, 150));
    const after = cpuSnapshot();
    const cpuPercent = cpuPercentFromDelta(before, after);
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
    return { cpuPercent, memPercent, totalMemBytes: totalMem, freeMemBytes: freeMem };
});

ipcHandle('win:minimize', () => mainWindow && mainWindow.minimize());

// Manual resize for the dashboard: Chromium/Windows drop the native
// resize-by-dragging-the-frame-edge behavior entirely once a BrowserWindow is
// `transparent: true`, regardless of `resizable: true` (there's no OS-level
// hit-test border to grab). ResizeHandles.tsx renders invisible edge/corner
// strips instead and drives these three the same way DockedRail's detach-
// drag drives rail:beginFloatDrag/dragMove/endFloatDrag -- main pulls the
// live cursor position itself rather than trusting renderer-supplied
// coordinates, matching that existing pattern.
ipcHandle('window:beginResize', (_event, direction) => {
    if (!isValidResizeDirection(direction)) {
        console.warn('[main] dropped window:beginResize with an invalid direction:', direction);
        return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Clears out a settle check left over from some earlier drag that just
    // happens to still be pending -- without this, it could fire mid-resize
    // (the 'moved' guard above stops anything NEW from being scheduled once
    // dashboardResizeState is set, but doesn't touch a timer already queued
    // before this call) and snap the window while the user is still resizing.
    if (mainMoveSettleTimer) {
        clearTimeout(mainMoveSettleTimer);
        mainMoveSettleTimer = null;
    }
    dashboardResizeState = {
        direction,
        startBounds: mainWindow.getBounds(),
        startCursor: screen.getCursorScreenPoint(),
    };
});

ipcOn('window:resizeMove', () => {
    if (!dashboardResizeState || !mainWindow || mainWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - dashboardResizeState.startCursor.x;
    const dy = cursor.y - dashboardResizeState.startCursor.y;
    const bounds = computeResizedBounds(
        dashboardResizeState.startBounds,
        dashboardResizeState.direction,
        dx,
        dy,
        MAIN_WINDOW_MIN_WIDTH,
        MAIN_WINDOW_MIN_HEIGHT,
    );
    mainWindow.setBounds(bounds);
});

ipcHandle('window:endResize', () => {
    dashboardResizeState = null;
});

// The single guarded quit path, shared by the in-app close button
// (app:quit) and every native quit gesture (Cmd+Q, Dock "Quit", logout --
// all of which arrive as before-quit below). Previously only the in-app
// button ran the recording guard; the native gestures set isQuitting and
// let every window close unguarded, silently discarding a live recording.
async function runGuardedQuit() {
    // Guards against a second invocation (a rapid double-click on the close
    // button, Cmd+Q pressed twice, or the native 'close' handler above
    // already running) starting an overlapping second guarded-close sequence.
    if (closeInProgress) return;
    closeInProgress = true;
    try {
        const proceed = await performGuardedClose();
        if (!proceed) return;
        // Lets the re-entrant before-quit (from app.quit() below) through
        // instead of guarding a second time.
        closeConfirmed = true;
        // Set before destroying windows, not after -- destroying the last
        // one below synchronously fires 'window-all-closed', which needs
        // to see this flag already set to skip its own app.quit() call.
        // Destroying them before before-quit's jobs wait (rather than
        // leaving them up during it) also means no new recording can be
        // started while the quit is pending.
        quitRequested = true;
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.destroy();
        }
        app.quit();
    } finally {
        closeInProgress = false;
    }
}

ipcHandle('app:quit', () => runGuardedQuit());

const BACKEND_PREFERRED_PORT = 8000;
const BACKEND_MAX_PORTS_TO_TRY = 20;
let BACKEND_URL = null;

let recoveryConfig = null;

// Cached so a renderer that mounts (or reloads) AFTER a status was sent can
// still learn the current state instead of being stuck on whatever default
// it started with. webContents.send fires-and-forgets -- Electron does not
// buffer it for listeners that register later, so the very first
// {state:'starting'} sent right after createWindow() was previously lost on
// every single launch (the renderer's listener isn't wired up that fast),
// leaving the lifecycle hook at its "healthy" default while the backend was
// actually still coming up.
let lastBackendStatus = null;

// Detects a backend that's hung but hasn't exited -- armCrashMonitor's
// 'exit' listener never fires for that case, so without this a deadlock
// left the app showing "stopped" forever with no automatic recovery.
// Skips a tick entirely (rather than probing) while a recovery is already
// in progress or the app is quitting, so it never fights attemptRecovery's
// own retry loop or spawns a process after shutdown has begun.
let watchdogTimer = null;
let watchdogConsecutiveFailures = 0;
// Last answer from the backend's /jobs (see fetchBackendBusy): whether a
// transcription job is queued/running. Only updated when the backend
// answers, so a run of missed probes during a job keeps the patient,
// busy threshold (watchdogThreshold) instead of dropping back to 3.
let backendKnownBusy = false;
let watchdogTickInFlight = false;

function stopHealthWatchdog() {
    if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }
}

// Central hook for EVERY backend:status push, whether it comes from main.js
// itself or from inside attemptRecovery (wired through
// recoveryConfig.onStatus, including its own recursive re-arm for a
// newly-recovered child that crashes again later) -- keeps lastBackendStatus
// authoritative regardless of source, and is the single place that stops the
// watchdog once a recovery cycle has exhausted its attempts. Without this,
// the watchdog kept ticking after landing on "failed", counted another
// ~15s of failures against the still-dead backend, and launched a brand new
// recovery cycle -- forever.
//
// Also the single place that forwards the push to both windows. The rail
// used to be left out entirely (only mainWindow ever received
// backend:status), leaving its useProcessingJobs restart-pause permanently
// inert -- "Lost track of this recording" could flash there during a
// backend restart the job actually survives. The dashboard used to be
// reached by handing mainWindow to attemptRecovery, which re-arms itself
// with whatever it was given -- a window captured at the first crash went
// stale as soon as the dashboard was ever recreated, and recovery status
// never reached the new one. attemptRecovery is no longer given a window at
// all; reading the module-level ones here, at send time, always hits the
// current windows.
function sendBackendStatus(payload) {
    lastBackendStatus = payload;
    if (payload.state === 'failed') {
        stopHealthWatchdog();
    }
    for (const w of [mainWindow, railWindow]) {
        if (w && !w.isDestroyed()) {
            w.webContents.send('backend:status', payload);
        }
    }
}

ipcHandle('backend:getStatus', () => lastBackendStatus);

// Synchronous (sendSync from preload.js) so window.BACKEND_CONFIG already
// holds the token before any renderer code runs -- api.ts reads it at
// module load. Only answered for this app's own two windows' top frames:
// both only ever load bundled file:// pages (preventNavigation), so
// nothing else should ever be asking. Registered directly rather than via
// ipcOn: a sendSync caller blocks until returnValue is set, so an untrusted
// sender still has to get an answer (null), not silence.
ipcMain.on('backend:getToken', (event) => {
    event.returnValue = trustedIpcSender(event) ? backendAuthToken : null;
});

function startHealthWatchdog() {
    stopHealthWatchdog();
    watchdogConsecutiveFailures = 0;
    // A fresh (or just-restarted) backend has no jobs; the first answered
    // probe below corrects this if it does.
    backendKnownBusy = false;
    watchdogTimer = setInterval(async () => {
        if (!recoveryConfig || isRecovering() || shuttingDown) return;
        // A probe plus the /jobs check can take up to ~4.5s of this 5s
        // interval; never let two ticks overlap and double-count a miss.
        if (watchdogTickInFlight) return;
        watchdogTickInFlight = true;
        try {
            const ok = await probeHealthOnce(recoveryConfig.backendUrl, undefined, backendAuthToken);
            if (ok) {
                const busy = await fetchBackendBusy(recoveryConfig.backendUrl, backendAuthToken);
                if (busy !== null) backendKnownBusy = busy;
            }
            const busy = watchdogBusy(backendKnownBusy, lastRailIsProcessing);
            const next = nextWatchdogState(watchdogConsecutiveFailures, ok, watchdogThreshold(busy));
            watchdogConsecutiveFailures = next.consecutiveFailures;
            if (next.shouldRestart) {
                watchdogConsecutiveFailures = 0;
                // attemptRecovery stops the tracked (hung) backend -- its
                // whole process group, escalating to SIGKILL -- and clears
                // the port before spawning a fresh one; no separate kill
                // step needed here. sendBackendStatus (via
                // recoveryConfig.onStatus) stops this very watchdog if the
                // cycle ends in "failed".
                await attemptRecovery({ ...recoveryConfig, crashInfo: null });
            }
        } finally {
            watchdogTickInFlight = false;
        }
    }, WATCHDOG_INTERVAL_MS);
}

// Runs a recovery attempt and, only if it actually succeeded (not "failed"
// -- exhausted retries), resumes the watchdog. Shared by every
// attemptRecovery call site in this file so a successful manual Retry (or a
// crash-triggered recovery mid-session) always leaves ongoing monitoring
// running afterward, while a failed one leaves it off until the user
// explicitly retries again.
async function runRecovery(crashInfo) {
    await attemptRecovery({ ...recoveryConfig, crashInfo });
    if (lastBackendStatus?.state !== 'failed') {
        startHealthWatchdog();
    }
}

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

// userData is only guaranteed stable once the app is ready, so crash logging
// is armed as the very first thing in the whenReady callback below rather
// than at module load -- anything that throws before that point still goes
// to Electron's own crash dialog/console, same as before this existed.
const crashLogDir = () => path.join(app.getPath('userData'), 'logs');

app.whenReady().then(async () => {
    if (!gotSingleInstanceLock) return;
    // uncaughtException exits via process.exit(1), which skips before-quit
    // and its stopBackend -- kill the backend synchronously first.
    armProcessCrashLogging(crashLogDir(), process, { beforeExit: () => killAllBackendsSync() });

    Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate({
        platform: process.platform,
        isPackaged: app.isPackaged,
        appName: app.name,
    })));

    // Fallback for the renderer's darwin getDisplayMedia() call
    // (src/rail/capture/electronCapture.ts). On macOS 15+ with the native
    // system picker available, Electron resolves the request via the
    // picker directly and never invokes this handler at all -- it exists
    // only for macOS <15 or if the picker is ever unavailable, in which
    // case we hand back the first screen source with no system audio
    // (there is no Electron-mediated system-audio path on macOS below 15;
    // mic capture is unaffected -- it's handled entirely client-side).
    // Electron grants every web permission request by default. Only what
    // the app's own pages actually use is allowed (see permissions.js);
    // everything else -- and anything from a non-file:// origin -- is denied.
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        callback(isAllowedPermission(permission, details?.requestingUrl ?? webContents?.getURL?.()));
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
        return isAllowedPermission(permission, requestingOrigin || webContents?.getURL?.());
    });

    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
            callback({ video: sources[0] });
        }).catch(() => {
            callback({});
        });
    }, { useSystemPicker: true });

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
        [BACKEND_TOKEN_ENV]: backendAuthToken,
        ...(app.isPackaged ? {
            APP_DATA_DIR: app.getPath('userData'),
            ...(() => {
                const { ffmpegBin, ffprobeBin } = resolveFfmpegPaths(process.resourcesPath);
                return { FFMPEG_BIN: ffmpegBin, FFPROBE_BIN: ffprobeBin };
            })(),
            LLAMA_SERVER_BIN: resolveLlamaServerPath(process.resourcesPath),
            SPEAKER_MODEL_PATH: resolveSpeakerModelPath(process.resourcesPath),
        } : {}),
    };
    const backendProcess = startBackend(backend.command, backend.args, backend.cwd, backendEnv);

    // Show the window right away instead of blocking on backend health: a
    // cold first launch (antivirus scanning freshly-written files) can take
    // up to healthTimeoutMs below, and gating window creation on that left
    // users staring at nothing for the whole wait, looking like the app
    // never launched. BackendStatusBanner (driven by the backend:status
    // events below) renders "starting"/"failed" as a loading state instead
    // -- the renderer already handles a down backend everywhere else, so
    // there's nothing left that actually needs the gate.
    createWindow();
    createRailWindow();
    // A getter, not the window itself: the updater's listeners live for the
    // whole app session, and a captured reference would keep sending to a
    // destroyed dashboard if it's ever recreated (macOS Dock reopen).
    armAutoUpdate(() => mainWindow);
    sendBackendStatus({ state: 'starting' });

    // Packaged mode gets a longer timeout: a first launch after install can hit
    // slower disk I/O and antivirus scanning of freshly-written files, and the
    // frozen backend's measured cold start (~7.6s) leaves thin margin under 15s.
    // Dev mode launches an already-installed venv python, which is fast and
    // doesn't have this risk, so its timeout stays unchanged.
    const healthTimeoutMs = app.isPackaged ? 30000 : 15000;

    recoveryConfig = {
        pythonExe: backend.command,
        args: backend.args,
        cwd: backend.cwd,
        env: backendEnv,
        backendUrl: BACKEND_URL,
        authToken: backendAuthToken,
        logDir: crashLogDir(),
        isShuttingDown: () => shuttingDown,
        // Recovery's own health wait must tolerate the same slow cold start
        // the initial launch does -- attemptRecovery's hardcoded 15s default
        // was shorter than the packaged 30s above, so on a machine with a
        // >15s (but <30s) cold start, the watchdog killed a backend that was
        // still legitimately booting and could never recover in the window
        // it was given, looping forever.
        healthTimeoutMs,
        // Keeps main.js's lastBackendStatus cache (and the watchdog-pause
        // hook below) authoritative for every push, including the ones
        // attemptRecovery sends directly rather than through
        // sendBackendStatus.
        onStatus: sendBackendStatus,
    };
    // Armed before waitForHealth settles, not after -- a crash during the
    // initial health wait used to go unrecovered (the app just quit via the
    // catch block below); now it's handled the same as any later crash.
    armCrashMonitor(backendProcess, (code, signal) => {
        runRecovery({ exitCode: code, signal });
    });

    try {
        await waitForHealth(BACKEND_URL, healthTimeoutMs, backendProcess, backendAuthToken);
        sendBackendStatus({ state: 'ready' });
        // Only armed once the backend has actually proven healthy at least
        // once (per-launch grace period) -- starting it unconditionally
        // used to mean a backend that was still slowly cold-starting past
        // even the 30s packaged timeout got the watchdog counting failures
        // against it immediately, before the user ever got a chance to
        // just wait it out via Retry.
        startHealthWatchdog();
    } catch (err) {
        // No dialog + app.quit() here anymore: the window already exists and
        // the lifecycle-driven "failed" banner (with its Retry button, wired
        // to the same recovery path the watchdog uses) gives the user a way
        // forward without restarting the whole app. The watchdog stays off
        // until that Retry succeeds (backend:restart below) instead of
        // immediately starting to count failures against a backend that
        // just failed its very first health check.
        const logTail = getBackendLogTail();
        const detail = logTail
            ? `${err?.message ?? err}\n\nBackend output:\n${logTail}`
            : String(err?.message ?? err);
        console.error('[backend] failed to become healthy on startup:', detail);
        // A crash during startup fires BOTH the crash monitor armed above
        // (which starts a recovery and publishes "restarting") and this
        // wait's own exit listener. Publishing "failed" here on top of that
        // showed a false failure, stopped the watchdog, and left Retry
        // inert (isRecovering() is true). The running recovery reports its
        // own outcome -- "up" or a real "failed" -- so defer to it.
        if (isRecovering()) return;
        sendBackendStatus({ state: 'failed', logTail: detail });
    }
});

ipcHandle('updater:install', async () => {
    // Same guard app:quit uses: quitAndInstall() fires app.quit(), whose
    // before-quit handler sets isQuitting and lets every window close
    // unguarded -- so the recording/pending-upload guard has to run HERE,
    // before the quit machinery is ever engaged. closeInProgress prevents
    // this overlapping with an already-running close/quit sequence.
    // Only for a downloaded update: this destroys every window before
    // installing, so an invoke from any other state (a stale button, a
    // renderer bug) must not start that. Never on macOS, where updates are
    // check-only (see armAutoUpdate).
    if (process.platform === 'darwin' || getLastStatus().state !== 'ready') return;
    if (closeInProgress) return;
    closeInProgress = true;
    try {
        const proceed = await performGuardedClose();
        if (!proceed) return;
        // quitAndInstall re-enters before-quit -- don't guard a second time.
        closeConfirmed = true;
        // Mirror app:quit: destroy the windows BEFORE the jobs wait, so no
        // new recording can start while the quit is pending, and wait out
        // the transcription job the guarded stop just created BEFORE
        // spawning the installer -- quitAndInstall launches NSIS
        // immediately, and an installer running against a live app +
        // mid-transcription backend is a file-in-use failure or a corrupted
        // update.
        // Mirror before-quit exactly: no watchdog-triggered restarts and no
        // recovery spawns once install has begun -- the watchdog killing a
        // CPU-saturated backend during the jobs wait below would destroy the
        // very transcription the wait exists to protect.
        await runInstallShutdownSequence({
            stopHealthWatchdog,
            markShuttingDown: () => { shuttingDown = true; },
            markQuitRequested: () => { quitRequested = true; },
            destroyAllWindows: () => {
                for (const w of BrowserWindow.getAllWindows()) {
                    if (!w.isDestroyed()) w.destroy();
                }
            },
            fetchActiveJobsForQuitGuard,
            waitForActiveJobsToFinish,
        });
        // Jobs are done and windows are gone -- let before-quit take its
        // fast path (stopBackend + immediate quit) when quitAndInstall
        // fires app.quit().
        quitConfirmed = true;
        // Windows are already destroyed and quitRequested suppressed
        // window-all-closed's quit, so a failed install must still end in a
        // quit -- and quitAndInstall doesn't reliably throw when it fails
        // (see installUpdateOrQuit).
        installUpdateOrQuit(() => app.quit());
    } finally {
        closeInProgress = false;
    }
});
ipcHandle('updater:getStatus', () => getLastStatus());

ipcHandle('app:getVersion', () => app.getVersion());

ipcHandle('backend:restart', async () => {
    if (!recoveryConfig || isRecovering()) return;
    // Timed via AbortSignal (probeHealthOnce) -- a plain fetch with no
    // timeout would hang this handler forever against exactly the kind of
    // hung-but-accepting-connections backend this button exists to recover.
    const ok = await probeHealthOnce(recoveryConfig.backendUrl, undefined, backendAuthToken);
    if (ok) {
        // Already healthy -- don't spawn a second process on the same port,
        // but this is still a valid point to resume the watchdog if an
        // earlier failed cycle had paused it (G2), and to tell the renderer
        // so its failed banner clears.
        startHealthWatchdog();
        const status = statusForHealthyRetry(lastBackendStatus);
        if (status) sendBackendStatus(status);
        return;
    }
    await runRecovery(null);
});

// Best-effort check for a still-running transcription job, used only to
// decide whether before-quit below should warn before killing the backend.
// Short-timeouts and swallows errors -- an unreachable/slow backend should
// never block quitting, just skip the warning.
async function fetchActiveJobsForQuitGuard() {
    try {
        const res = await fetch(`${BACKEND_URL}/jobs`, {
            headers: backendAuthHeaders(backendAuthToken),
            signal: AbortSignal.timeout(1500),
        });
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
    // Every native quit gesture (Cmd+Q, Dock "Quit", the app menu's Quit,
    // macOS logout/shutdown, a bare app.quit()) lands here first, and the
    // recording guard has to run BEFORE isQuitting is set below -- that flag
    // is what lets both windows' 'close' handlers through unguarded. So on
    // first entry, defer to runGuardedQuit (Stop && Save / Cancel, then
    // destroy the windows and call app.quit() again); only the re-entry,
    // with closeConfirmed set, carries on into the real shutdown. Cancel
    // leaves the app exactly as it was, nothing below having run yet.
    //
    // Trade-off for OS logout/shutdown: on macOS, preventing default here
    // makes the system report that DeskRecap interrupted the logout. That's
    // deliberate while a recording or upload would otherwise be lost -- the
    // user gets the Stop && Save dialog and simply logs out again after.
    // With nothing to guard, runGuardedQuit proceeds without any dialog
    // after a single async hop, so a normal logout isn't held up beyond the
    // (pre-existing) active-job wait below. On Windows, Electron doesn't
    // emit before-quit for a shutdown/logoff at all; that case still goes
    // through the windows' own 'close' handlers as before.
    const step = beforeQuitStep({ closeConfirmed, quitConfirmed, beforeQuitInFlight });
    if (step === 'guard') {
        e.preventDefault();
        runGuardedQuit();
        return;
    }
    // Lets the rail window's 'close' handler distinguish "the user is
    // quitting the whole app / the OS is shutting down" (let it close for
    // real) from "an isolated close gesture aimed at just this window"
    // (Alt+F4 on the rail specifically, which should only hide/dock it).
    // 'before-quit' fires ahead of Electron delivering 'close' to every
    // top-level window, so this is set in time either way -- set
    // unconditionally and immediately, regardless of the guard below.
    isQuitting = true;
    // No more watchdog-triggered restarts once quitting has begun.
    stopHealthWatchdog();
    // Set immediately and unconditionally too -- an in-flight recovery attempt
    // (or one that starts between now and the backend actually being stopped
    // below) must never spawn a fresh backend process once quitting has begun.
    shuttingDown = true;

    if (step === 'finish') {
        // Hold the quit until the backend has actually stopped, then quit
        // again. It used to be fired and forgotten, which only worked
        // because the backend shared Electron's process group; now that it's
        // detached on macOS/Linux (see backendSpawnOptions), a backend that
        // ignored SIGTERM would outlive the app unless the SIGKILL
        // escalation gets to run. Bounded by STOP_GRACE_MS (~5s) in the
        // worst case. killAllBackendsSync on process 'exit' backs this up.
        if (backendStoppedForQuit) return;
        e.preventDefault();
        if (backendStopForQuitInFlight) return;
        backendStopForQuitInFlight = true;
        stopBackend()
            .catch((err) => console.error('[main] stopping the backend on quit failed:', err))
            .finally(() => {
                backendStoppedForQuit = true;
                app.quit();
            });
        return;
    }
    if (step === 'keepWaiting') {
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
// Last line of defence for every way out that skips before-quit (app.exit,
// an uncaughtException exit, a quit while the stop above is still pending):
// synchronously kill any backend still running, so a detached backend and
// its ffmpeg children never outlive the app and hold the port next launch.
process.on('exit', () => {
    killAllBackendsSync();
});

app.on('window-all-closed', () => {
    if (quitRequested) return; // app:quit's handler already called app.quit() itself
    if (process.platform !== 'darwin') app.quit();
});
// macOS Dock click. The dashboard is normally just hidden (see its 'close'
// handler), so show it again; recreate either window only if it's actually
// gone, so the app can always record again without a relaunch. Skipped
// until whenReady has resolved the backend port, or this would race it and
// build a second set of windows pointed at no backend.
// Shared by the macOS Dock click ('activate') and a relaunch attempt
// ('second-instance' with no dashboard left).
function reopenWindows() {
    // closeConfirmed: a quit is already underway (windows destroyed ahead
    // of before-quit's job wait) -- don't resurrect them mid-shutdown.
    if (!resolvedBackendPort || closeConfirmed || isQuitting) return;
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
    } else {
        mainWindow.show();
    }
    if (!railWindow || railWindow.isDestroyed()) {
        createRailWindow();
    }
}

app.on('activate', () => {
    reopenWindows();
});