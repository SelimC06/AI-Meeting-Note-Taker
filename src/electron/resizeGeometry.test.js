import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeResizedBounds } from './resizeGeometry.js';

const START = { x: 100, y: 100, width: 800, height: 450 };
const MIN_WIDTH = 640;
const MIN_HEIGHT = 420;

test('dragging the east handle grows width without moving x', () => {
    const bounds = computeResizedBounds(START, 'e', 50, 0, MIN_WIDTH, MIN_HEIGHT);
    assert.equal(bounds.width, 850);
    assert.equal(bounds.x, START.x);
    assert.equal(bounds.height, START.height);
    assert.equal(bounds.y, START.y);
});

test('dragging the west handle grows width and shifts x left, keeping the east edge fixed', () => {
    const bounds = computeResizedBounds(START, 'w', -50, 0, MIN_WIDTH, MIN_HEIGHT);
    assert.equal(bounds.width, 850);
    assert.equal(bounds.x, 50);
    assert.equal(bounds.x + bounds.width, START.x + START.width);
});

test('dragging the south handle grows height without moving y', () => {
    const bounds = computeResizedBounds(START, 's', 0, 30, MIN_WIDTH, MIN_HEIGHT);
    assert.equal(bounds.height, 480);
    assert.equal(bounds.y, START.y);
});

test('dragging the north handle grows height and shifts y up, keeping the south edge fixed', () => {
    const bounds = computeResizedBounds(START, 'n', 0, -30, MIN_WIDTH, MIN_HEIGHT);
    assert.equal(bounds.height, 480);
    assert.equal(bounds.y, 70);
    assert.equal(bounds.y + bounds.height, START.y + START.height);
});

test('a corner direction resizes both axes at once', () => {
    const bounds = computeResizedBounds(START, 'se', 50, 30, MIN_WIDTH, MIN_HEIGHT);
    assert.equal(bounds.width, 850);
    assert.equal(bounds.height, 480);
});

test('shrinking past the minimum width clamps instead of collapsing further', () => {
    const bounds = computeResizedBounds(START, 'e', -1000, 0, MIN_WIDTH, MIN_HEIGHT);
    assert.equal(bounds.width, MIN_WIDTH);
});

test('shrinking the west handle past the minimum width clamps the east edge from drifting further', () => {
    const bounds = computeResizedBounds(START, 'w', 1000, 0, MIN_WIDTH, MIN_HEIGHT);
    assert.equal(bounds.width, MIN_WIDTH);
    assert.equal(bounds.x + bounds.width, START.x + START.width);
});

test('shrinking past the minimum height clamps instead of collapsing further', () => {
    const bounds = computeResizedBounds(START, 's', 0, -1000, MIN_WIDTH, MIN_HEIGHT);
    assert.equal(bounds.height, MIN_HEIGHT);
});

test('isValidResizeDirection accepts the eight compass handles only', async () => {
    const { isValidResizeDirection } = await import('./resizeGeometry.js');
    for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) assert.equal(isValidResizeDirection(d), true, d);
    for (const d of ['news', '', 'x', null, undefined, 1, ['e']]) assert.equal(isValidResizeDirection(d), false, String(d));
});
