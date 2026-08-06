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
