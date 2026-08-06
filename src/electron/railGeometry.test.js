import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    computeRailBounds,
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
