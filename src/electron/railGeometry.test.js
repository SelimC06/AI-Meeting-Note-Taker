import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    computeRailBounds,
    computeCenteredBounds,
    computeDockSlotScreenRect,
    isPointInRect,
    computeCornerSnap,
    RAIL_WIDTH,
    RAIL_HEIGHT,
    RAIL_ERROR_PANEL_HEIGHT,
    RAIL_GAP,
    RAIL_INSET_TOP,
} from './railGeometry.js';

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };

test('computeRailBounds centers the dock horizontally and insets it from the top', () => {
    const bounds = computeRailBounds(WORK_AREA);
    assert.equal(bounds.width, RAIL_WIDTH);
    assert.equal(bounds.height, RAIL_HEIGHT);
    assert.equal(bounds.x, Math.round((WORK_AREA.width - RAIL_WIDTH) / 2));
    assert.equal(bounds.y, RAIL_INSET_TOP);
});

test('computeRailBounds grows height only when errorVisible is true', () => {
    const bounds = computeRailBounds(WORK_AREA, { errorVisible: true });
    assert.equal(bounds.width, RAIL_WIDTH);
    assert.equal(bounds.height, RAIL_HEIGHT + RAIL_GAP + RAIL_ERROR_PANEL_HEIGHT);
    // x/y stay anchored to the same top-center point regardless of error state
    assert.equal(bounds.x, Math.round((WORK_AREA.width - RAIL_WIDTH) / 2));
    assert.equal(bounds.y, RAIL_INSET_TOP);
});

test('computeRailBounds offsets by a non-zero workArea origin', () => {
    const offsetArea = { x: 100, y: 40, width: 1600, height: 900 };
    const bounds = computeRailBounds(offsetArea);
    assert.equal(bounds.x, offsetArea.x + Math.round((offsetArea.width - RAIL_WIDTH) / 2));
    assert.equal(bounds.y, offsetArea.y + RAIL_INSET_TOP);
});

test('computeCenteredBounds centers a box of the given size on the point', () => {
    const bounds = computeCenteredBounds({ x: 500, y: 300 }, RAIL_WIDTH, RAIL_HEIGHT);
    assert.equal(bounds.width, RAIL_WIDTH);
    assert.equal(bounds.height, RAIL_HEIGHT);
    assert.equal(bounds.x, 500 - Math.round(RAIL_WIDTH / 2));
    assert.equal(bounds.y, 300 - Math.round(RAIL_HEIGHT / 2));
});

test('computeCenteredBounds rounds fractional centering', () => {
    const bounds = computeCenteredBounds({ x: 501, y: 301 }, 41, 41);
    assert.equal(bounds.x, 501 - Math.round(41 / 2));
    assert.equal(bounds.y, 301 - Math.round(41 / 2));
});

test('computeDockSlotScreenRect offsets a client rect into screen space using the main window content bounds', () => {
    const mainContentBounds = { x: 100, y: 50, width: 800, height: 450 };
    const slotClientRect = { x: 12, y: 8, width: 208, height: 40 };
    const rect = computeDockSlotScreenRect(mainContentBounds, slotClientRect);
    assert.equal(rect.x, 112);
    assert.equal(rect.y, 58);
    assert.equal(rect.width, 208);
    assert.equal(rect.height, 40);
});

test('computeDockSlotScreenRect rounds fractional client coordinates', () => {
    const mainContentBounds = { x: 0, y: 0, width: 800, height: 450 };
    const slotClientRect = { x: 12.4, y: 7.6, width: 208.2, height: 39.9 };
    const rect = computeDockSlotScreenRect(mainContentBounds, slotClientRect);
    assert.equal(rect.x, 12);
    assert.equal(rect.y, 8);
    assert.equal(rect.width, 208);
    assert.equal(rect.height, 40);
});

test('isPointInRect is true for a point inside the rect, including its edges', () => {
    const rect = { x: 100, y: 100, width: 200, height: 40 };
    assert.equal(isPointInRect({ x: 150, y: 120 }, rect), true);
    assert.equal(isPointInRect({ x: 100, y: 100 }, rect), true);
    assert.equal(isPointInRect({ x: 300, y: 140 }, rect), true);
});

test('isPointInRect is false for a point outside the rect', () => {
    const rect = { x: 100, y: 100, width: 200, height: 40 };
    assert.equal(isPointInRect({ x: 99, y: 120 }, rect), false);
    assert.equal(isPointInRect({ x: 150, y: 141 }, rect), false);
});

test('computeCornerSnap snaps to the left edge when within the threshold', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    const bounds = { x: 10, y: 500, width: RAIL_WIDTH, height: RAIL_HEIGHT };
    const snapped = computeCornerSnap(workArea, bounds, 24);
    assert.equal(snapped.x, 0);
    assert.equal(snapped.y, 500);
});

test('computeCornerSnap snaps to the bottom-right corner when within the threshold on both axes', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    const bounds = { x: 1920 - RAIL_WIDTH - 5, y: 1080 - RAIL_HEIGHT - 5, width: RAIL_WIDTH, height: RAIL_HEIGHT };
    const snapped = computeCornerSnap(workArea, bounds, 24);
    assert.equal(snapped.x, 1920 - RAIL_WIDTH);
    assert.equal(snapped.y, 1080 - RAIL_HEIGHT);
});

test('computeCornerSnap leaves position unchanged when far from every edge', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    const bounds = { x: 800, y: 500, width: RAIL_WIDTH, height: RAIL_HEIGHT };
    const snapped = computeCornerSnap(workArea, bounds, 24);
    assert.equal(snapped.x, 800);
    assert.equal(snapped.y, 500);
});

test('computeCornerSnap respects a non-zero workArea origin', () => {
    const workArea = { x: 100, y: 40, width: 1600, height: 900 };
    const bounds = { x: 105, y: 500, width: RAIL_WIDTH, height: RAIL_HEIGHT };
    const snapped = computeCornerSnap(workArea, bounds, 24);
    assert.equal(snapped.x, 100);
});

test('computeCornerSnap (default, rail behavior) pulls a window flush no matter how far past the edge it is', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    // The rail should always be fully reachable, so even deeply off-screen
    // (x is hugely negative here) it still gets pulled flush to the edge --
    // this is the ORIGINAL behavior and must stay the default.
    const bounds = { x: -400, y: 500, width: RAIL_WIDTH, height: RAIL_HEIGHT };
    const snapped = computeCornerSnap(workArea, bounds, 24);
    assert.equal(snapped.x, 0);
    assert.equal(snapped.y, 500);
});

test('computeCornerSnap with allowOffScreen leaves a window well past an edge alone instead of yanking it back on-screen', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    // Deliberately dragged mostly off the left edge -- x is deeply negative,
    // which satisfies a bare "<= threshold" check and (without
    // allowOffScreen) would snap flush to x=0 no matter how far off it was.
    const bounds = { x: -400, y: 500, width: 800, height: 450 };
    const snapped = computeCornerSnap(workArea, bounds, 24, { allowOffScreen: true });
    assert.equal(snapped.x, -400);
    assert.equal(snapped.y, 500);
});

test('computeCornerSnap with allowOffScreen still pulls flush from just barely past an edge', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    // 10px past the left edge -- still within the magnetic zone on the
    // outside, so this should dock flush same as approaching from inside.
    const bounds = { x: -10, y: 500, width: 800, height: 450 };
    const snapped = computeCornerSnap(workArea, bounds, 24, { allowOffScreen: true });
    assert.equal(snapped.x, 0);
});
