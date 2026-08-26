// Pure bounds math for dragging an edge/corner handle to resize a window.
// A direction like 'e' or 'se' says which side(s) of the window the handle
// being dragged belongs to -- the OPPOSITE side(s) stay anchored in place
// (dragging the west handle grows/shrinks westward, so the east edge must
// not move), which is why 'w'/'n' also shift x/y while 'e'/'s' don't.
export function computeResizedBounds(startBounds, direction, dx, dy, minWidth, minHeight) {
    let { x, y, width, height } = startBounds;

    if (direction.includes('e')) {
        width = Math.max(startBounds.width + dx, minWidth);
    } else if (direction.includes('w')) {
        width = Math.max(startBounds.width - dx, minWidth);
        x = startBounds.x + startBounds.width - width;
    }

    if (direction.includes('s')) {
        height = Math.max(startBounds.height + dy, minHeight);
    } else if (direction.includes('n')) {
        height = Math.max(startBounds.height - dy, minHeight);
        y = startBounds.y + startBounds.height - height;
    }

    return { x, y, width, height };
}
