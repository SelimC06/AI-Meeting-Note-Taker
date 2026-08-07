export const RAIL_SLIDE_DURATION_MS = 220;

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

export function computeSlideY(startY, endY, elapsedMs, durationMs) {
    if (elapsedMs <= 0) return startY;
    if (elapsedMs >= durationMs) return endY;
    const eased = easeOutCubic(elapsedMs / durationMs);
    return Math.round(startY + (endY - startY) * eased);
}

// Returns a Y position guaranteed to place the window fully above the work
// area (bottom edge at or above workArea.y), unlike the naive
// `bounds.y - bounds.height` which is only offset from the rail's own resting
// position and can leave a sliver still inside the work area.
export function computeOffScreenY(workArea, bounds) {
    return workArea.y - bounds.height;
}
