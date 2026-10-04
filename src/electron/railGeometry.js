// 296, up from the pre-captions 280: the pill gained the cc toggle (live
// captions, Tier 2.2) and at 280 the row overflowed its fixed-width
// window, visually breaking the rail. 296 is the slimmed toggle's snug
// fit -- 312 read as too long.
export const RAIL_WIDTH = 296;
export const RAIL_HEIGHT = 40;
export const RAIL_ERROR_PANEL_HEIGHT = 72;
// Status strip (~20px) + up to two caption lines + padding.
export const RAIL_CAPTIONS_PANEL_HEIGHT = 76;
export const RAIL_GAP = 8;
export const RAIL_INSET_TOP = 10;

// One place for "how tall is the rail window right now": the base pill
// plus whichever panels (error toast, live captions) are currently shown
// below it, each with its gap.
export function computeRailHeight({ errorVisible = false, captionsVisible = false } = {}) {
    let height = RAIL_HEIGHT;
    if (captionsVisible) height += RAIL_GAP + RAIL_CAPTIONS_PANEL_HEIGHT;
    if (errorVisible) height += RAIL_GAP + RAIL_ERROR_PANEL_HEIGHT;
    return height;
}

export function computeRailBounds(workArea, { errorVisible = false, captionsVisible = false } = {}) {
    const height = computeRailHeight({ errorVisible, captionsVisible });

    return {
        x: workArea.x + Math.round((workArea.width - RAIL_WIDTH) / 2),
        y: workArea.y + RAIL_INSET_TOP,
        width: RAIL_WIDTH,
        height,
    };
}

export function computeCenteredBounds(point, width, height) {
    return {
        x: point.x - Math.round(width / 2),
        y: point.y - Math.round(height / 2),
        width,
        height,
    };
}

export function computeDockSlotScreenRect(mainContentBounds, slotClientRect) {
    return {
        x: mainContentBounds.x + Math.round(slotClientRect.x),
        y: mainContentBounds.y + Math.round(slotClientRect.y),
        width: Math.round(slotClientRect.width),
        height: Math.round(slotClientRect.height),
    };
}

export function isPointInRect(point, rect) {
    return (
        point.x >= rect.x &&
        point.x <= rect.x + rect.width &&
        point.y >= rect.y &&
        point.y <= rect.y + rect.height
    );
}

// allowOffScreen=false (the default) is the rail's original behavior: any
// edge at or past the threshold -- however far past, even hundreds of px
// off-screen -- gets pulled flush. That's intentional for the rail, a small
// dock the user generally wants fully reachable.
//
// allowOffScreen=true (the dashboard) bounds the check on BOTH sides instead
// of just one: without it, a window dragged far past an edge has a hugely
// NEGATIVE distance-to-edge, which still satisfies a bare "<= threshold" and
// got yanked flush on-screen no matter how far off it was -- there was never
// any way to leave a full window deliberately hanging half off-screen. This
// turns the check into a small magnetic zone straddling the edge instead
// (close from either side still snaps flush, same as before), matching how
// Windows' own edge docking behaves for ordinary windows.
// Threshold default dropped 24 -> 8px: at 24 the magnetism grabbed windows
// that were merely near an edge, which read as the app yanking itself out
// of the user's hands. 8px means you have to put it basically ON the edge
// for it to attach.
export function computeCornerSnap(workArea, bounds, threshold = 8, { allowOffScreen = false } = {}) {
    const within = (distance) => (allowOffScreen ? Math.abs(distance) <= threshold : distance <= threshold);

    const nearLeft = within(bounds.x - workArea.x);
    const nearRight = within((workArea.x + workArea.width) - (bounds.x + bounds.width));
    const nearTop = within(bounds.y - workArea.y);
    const nearBottom = within((workArea.y + workArea.height) - (bounds.y + bounds.height));

    let x = bounds.x;
    let y = bounds.y;

    if (nearLeft) x = workArea.x;
    else if (nearRight) x = workArea.x + workArea.width - bounds.width;

    if (nearTop) y = workArea.y;
    else if (nearBottom) y = workArea.y + workArea.height - bounds.height;

    return { x, y };
}

