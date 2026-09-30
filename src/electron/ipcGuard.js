// Every ipcMain listener in main.js trusts its payload to come from one of
// this app's own two windows, which only ever load bundled file:// pages
// (see preventNavigation in main.js). Nothing enforced that: an iframe, or
// a page some future bug navigated to, could call the same channels --
// write to the crash logs, drive the rail, move the storage folder.
// Pure (windows are passed in) so it's testable without Electron.
export function isTrustedIpcSender(event, windows) {
    const sender = event?.sender;
    const frame = event?.senderFrame;
    if (!sender || !frame) return false;
    const fromOwnWindow = windows.some((w) => w && !w.isDestroyed() && w.webContents === sender);
    if (!fromOwnWindow) return false;
    // Top frame only: no page of ours embeds frames, so anything else is
    // content that got in some other way.
    if (frame !== sender.mainFrame) return false;
    return typeof frame.url === 'string' && frame.url.startsWith('file://');
}
