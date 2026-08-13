export const RAIL_WIDTH = 280;
export const RAIL_HEIGHT = 40;
export const RAIL_ERROR_PANEL_HEIGHT = 72;
export const RAIL_GAP = 8;
export const RAIL_INSET_TOP = 10;

export function computeRailBounds(workArea, { errorVisible = false } = {}) {
    const height = errorVisible
        ? RAIL_HEIGHT + RAIL_GAP + RAIL_ERROR_PANEL_HEIGHT
        : RAIL_HEIGHT;

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

export function computeCornerSnap(workArea, bounds, threshold = 24) {
    // Math.abs, not a bare "<= threshold", matters here: without it, a
    // window dragged far past an edge (e.g. deliberately left mostly
    // off-screen) has a hugely NEGATIVE distance-to-edge, which still
    // satisfies "<= threshold" and got yanked flush on-screen no matter how
    // far off it was -- there was never any way to leave a window partially
    // off-screen. Bounding both directions makes this a small magnetic zone
    // straddling the edge (close from either side snaps flush), matching how
    // Windows' own edge docking behaves: it pulls a window in only when
    // you're right at the edge, and otherwise leaves you free to drag it as
    // far off-screen as you want.
    const nearLeft = Math.abs(bounds.x - workArea.x) <= threshold;
    const nearRight = Math.abs((workArea.x + workArea.width) - (bounds.x + bounds.width)) <= threshold;
    const nearTop = Math.abs(bounds.y - workArea.y) <= threshold;
    const nearBottom = Math.abs((workArea.y + workArea.height) - (bounds.y + bounds.height)) <= threshold;

    let x = bounds.x;
    let y = bounds.y;

    if (nearLeft) x = workArea.x;
    else if (nearRight) x = workArea.x + workArea.width - bounds.width;

    if (nearTop) y = workArea.y;
    else if (nearBottom) y = workArea.y + workArea.height - bounds.height;

    return { x, y };
}

