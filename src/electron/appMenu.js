// Replaces Electron's default application menu, which is built for a
// generic browser-like app: its View > Reload (Cmd/Ctrl+R) reloads whichever
// window is focused -- including the rail, whose renderer is the only place
// a live recording's MediaRecorder buffers exist -- and its Toggle DevTools
// / zoom items shipped in production builds too. Returned as a plain
// template (rather than a built Menu) so it can be unit-tested without an
// Electron harness; main.js hands it to Menu.buildFromTemplate.
export function buildAppMenuTemplate({ platform, isPackaged, appName }) {
    const isMac = platform === 'darwin';
    const template = [];

    if (isMac) {
        // The macOS app menu is where users expect Quit (Cmd+Q) and
        // Hide (Cmd+H) to live -- dropping it would leave those shortcuts
        // with nothing to trigger.
        template.push({
            label: appName,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        });
    }

    // Kept on every platform: on macOS, copy/paste/select-all in text fields
    // (settings, custom LLM keys, transcript search) only work through these
    // menu roles' accelerators -- there's no built-in fallback without them.
    template.push({
        label: 'Edit',
        submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'delete' },
            { type: 'separator' },
            { role: 'selectAll' },
        ],
    });

    if (isMac) {
        // Standard macOS Window menu (Cmd+M, Cmd+W). Cmd+W on the dashboard
        // only hides it (see main.js's darwin close handling) and on the rail
        // only docks it, so neither can lose a recording.
        template.push({
            label: 'Window',
            submenu: [
                { role: 'minimize' },
                { role: 'close' },
                { type: 'separator' },
                { role: 'front' },
            ],
        });
    }

    // Dev-only: reloading/inspecting a renderer is still useful while
    // working on the UI, just never in a build a user could record with.
    if (!isPackaged) {
        template.push({
            label: 'Developer',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
            ],
        });
    }

    return template;
}

const ZOOM_KEYS = new Set(['=', '-', '0', '+']);

// The zoom modifier is Cmd on macOS, not Ctrl -- checking only
// input.control (as disableZoom originally did) left Cmd+= / Cmd+- zooming
// both windows there, which throws the fixed-size rail's layout off.
export function isZoomShortcut(input, platform) {
    if (!input || !ZOOM_KEYS.has(input.key)) return false;
    return platform === 'darwin' ? !!input.meta : !!input.control;
}
