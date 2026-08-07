import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlideY, computeOffScreenY, RAIL_SLIDE_DURATION_MS } from './slideAnimation.js';

test('computeSlideY returns the start position at elapsed 0', () => {
    assert.equal(computeSlideY(0, 100, 0, 220), 0);
});

test('computeSlideY returns the end position once elapsed reaches the duration', () => {
    assert.equal(computeSlideY(0, 100, 220, 220), 100);
});

test('computeSlideY clamps to the end position past the duration', () => {
    assert.equal(computeSlideY(0, 100, 500, 220), 100);
});

test('computeSlideY eases out (front-loaded): more than half the distance is covered by the halfway point in time', () => {
    const y = computeSlideY(0, 100, 110, 220);
    assert.equal(y, 88); // ease-out-cubic(0.5) = 0.875 -> round(100 * 0.875)
});

test('computeSlideY works in the reverse direction (sliding up, end < start)', () => {
    assert.equal(computeSlideY(100, 0, 0, 220), 100);
    assert.equal(computeSlideY(100, 0, 220, 220), 0);
    assert.equal(computeSlideY(100, 0, 110, 220), 13); // round(100 - 100*0.875)
});

test('RAIL_SLIDE_DURATION_MS is 220', () => {
    assert.equal(RAIL_SLIDE_DURATION_MS, 220);
});

test('computeOffScreenY places the window fully above the work area', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    const bounds = { x: 838, y: 10, width: 244, height: 40 };
    const offScreenY = computeOffScreenY(workArea, bounds);
    assert.ok(offScreenY + bounds.height <= workArea.y);
});
