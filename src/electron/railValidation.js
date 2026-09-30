// Shape-validates rail IPC payloads at the main-process boundary. Both
// rail:pushStatus and the slotRect-carrying channels (rail:beginFloatDrag,
// rail:updateDockSlotRect) come from the renderer, and a malformed payload
// used to propagate straight through: DockedRail.tsx destructures the
// status object and calls level.slice(...) on it, so a bad shape threw
// during render and took down the whole sidebar via its ErrorBoundary; a
// NaN slotRect silently poisoned computeDockSlotScreenRect and permanently
// disabled drop-to-dock. Keeping this pure and in its own module (like
// railGeometry.js/closeGuard.js) makes it unit-testable without Electron.

const KNOWN_RAIL_STATUSES = new Set(['idle', 'starting', 'recording', 'paused']);
const RECORD_ERROR_KINDS = new Set(['permission-denied', 'generic']);

// What the dashboard may ask the rail to do over rail:command. The
// close-flow commands ('stopForClose', 'retryUploadForClose') are sent by
// main itself, straight to the rail's webContents, and are deliberately NOT
// here: a renderer triggering them would ack (and so unblock) a close
// handoff that main never started.
const RENDERER_RAIL_COMMANDS = new Set(['toggleRecord', 'pause', 'resume', 'retryUpload']);

export function isValidRailCommand(action) {
    return typeof action === 'string' && RENDERER_RAIL_COMMANDS.has(action);
}

// Returns a sanitized copy of `payload`, or null if it's malformed enough
// that the whole message should be dropped (status.status isn't a known
// playback state, or the payload isn't an object at all). A partially bad
// `level` array is repaired in place instead -- one stray NaN sample
// shouldn't drop the whole status update.
export function sanitizeRailStatus(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (!KNOWN_RAIL_STATUSES.has(payload.status)) return null;

    return {
        status: payload.status,
        elapsedLabel: typeof payload.elapsedLabel === 'string' ? payload.elapsedLabel : '00:00',
        level: Array.isArray(payload.level)
            ? payload.level.filter((n) => typeof n === 'number' && Number.isFinite(n))
            : [],
        recordError: typeof payload.recordError === 'string' ? payload.recordError : null,
        recordErrorKind: RECORD_ERROR_KINDS.has(payload.recordErrorKind) ? payload.recordErrorKind : null,
        isProcessing: !!payload.isProcessing,
        hasPendingUpload: !!payload.hasPendingUpload,
    };
}

// `null` is a deliberate, valid value here -- DockedRail sends it to
// explicitly disable the dock slot while the sidebar is collapsed (its
// container's rect doesn't change size when the OUTER wrapper collapses,
// so there's no geometry-based way to detect that; see DockedRail.tsx).
// Anything else must be a plain {x,y,width,height} object with finite
// numbers and a positive size, or it's rejected.
export function isValidSlotRect(rect) {
    if (rect === null) return true;
    if (!rect || typeof rect !== 'object') return false;
    const { x, y, width, height } = rect;
    return (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(width) &&
        Number.isFinite(height) &&
        width > 0 &&
        height > 0
    );
}

// rail:level -- the live level-meter samples, streamed separately from
// rail:pushStatus so the status push can stay throttled (see RailApp.tsx):
// the dashboard's docked meter drawing from the throttled status updated
// only ~5 times a second and looked laggy. More samples than any meter
// draws are dropped; each sample is clamped to 0..1.
export const RAIL_LEVEL_MAX_SAMPLES = 64;

export function sanitizeRailLevel(payload) {
    if (!Array.isArray(payload)) return null;
    return payload
        .slice(-RAIL_LEVEL_MAX_SAMPLES)
        .filter((n) => typeof n === 'number' && Number.isFinite(n))
        .map((n) => Math.min(1, Math.max(0, n)));
}

// Only worth an IPC hop to the dashboard while someone can see the docked
// meter: the rail docked (its own window hidden -- when it floats it draws
// its own meter) and the dashboard visible and not minimized.
export function shouldForwardRailLevel({ railVisible, dashboardVisible, dashboardMinimized }) {
    return !railVisible && dashboardVisible && !dashboardMinimized;
}
