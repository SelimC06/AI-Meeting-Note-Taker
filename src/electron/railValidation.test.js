import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRailStatus, isValidSlotRect, isValidRailCommand } from './railValidation.js';

const VALID_STATUS = {
    status: 'recording',
    elapsedLabel: '00:12',
    level: [0.1, 0.5, 0.9],
    recordError: null,
    recordErrorKind: null,
    isProcessing: false,
    hasPendingUpload: false,
};

test('sanitizeRailStatus passes through a well-formed payload unchanged', () => {
    assert.deepEqual(sanitizeRailStatus(VALID_STATUS), VALID_STATUS);
});

test('sanitizeRailStatus returns null for a non-object payload', () => {
    assert.equal(sanitizeRailStatus(null), null);
    assert.equal(sanitizeRailStatus(undefined), null);
    assert.equal(sanitizeRailStatus('recording'), null);
    assert.equal(sanitizeRailStatus(42), null);
});

test('sanitizeRailStatus returns null when status is not a known playback state', () => {
    assert.equal(sanitizeRailStatus({ ...VALID_STATUS, status: 'bogus' }), null);
    assert.equal(sanitizeRailStatus({ ...VALID_STATUS, status: undefined }), null);
});

test('sanitizeRailStatus strips non-finite entries out of level instead of dropping the whole payload', () => {
    const result = sanitizeRailStatus({ ...VALID_STATUS, level: [0.1, NaN, Infinity, 'x', 0.9] });
    assert.deepEqual(result.level, [0.1, 0.9]);
});

test('sanitizeRailStatus defaults level to [] when it is not an array', () => {
    const result = sanitizeRailStatus({ ...VALID_STATUS, level: 'not-an-array' });
    assert.deepEqual(result.level, []);
});

test('sanitizeRailStatus defaults elapsedLabel when missing or non-string', () => {
    assert.equal(sanitizeRailStatus({ ...VALID_STATUS, elapsedLabel: undefined }).elapsedLabel, '00:00');
    assert.equal(sanitizeRailStatus({ ...VALID_STATUS, elapsedLabel: 12 }).elapsedLabel, '00:00');
});

test('sanitizeRailStatus defaults recordError to null unless it is a string', () => {
    assert.equal(sanitizeRailStatus({ ...VALID_STATUS, recordError: undefined }).recordError, null);
    assert.equal(sanitizeRailStatus({ ...VALID_STATUS, recordError: { message: 'x' } }).recordError, null);
    assert.equal(sanitizeRailStatus({ ...VALID_STATUS, recordError: 'mic unavailable' }).recordError, 'mic unavailable');
});

test('sanitizeRailStatus coerces isProcessing/hasPendingUpload to booleans', () => {
    const result = sanitizeRailStatus({ ...VALID_STATUS, isProcessing: 1, hasPendingUpload: 0 });
    assert.equal(result.isProcessing, true);
    assert.equal(result.hasPendingUpload, false);
});

test('isValidSlotRect accepts null as an explicit disable signal', () => {
    assert.equal(isValidSlotRect(null), true);
});

test('isValidSlotRect accepts a well-formed positive-size rect', () => {
    assert.equal(isValidSlotRect({ x: 20, y: 5, width: 280, height: 40 }), true);
    assert.equal(isValidSlotRect({ x: -10, y: -5, width: 1, height: 1 }), true);
});

test('isValidSlotRect rejects undefined, non-objects, and arrays', () => {
    assert.equal(isValidSlotRect(undefined), false);
    assert.equal(isValidSlotRect('rect'), false);
    assert.equal(isValidSlotRect(42), false);
});

test('isValidSlotRect rejects non-finite coordinates', () => {
    assert.equal(isValidSlotRect({ x: NaN, y: 5, width: 280, height: 40 }), false);
    assert.equal(isValidSlotRect({ x: 20, y: Infinity, width: 280, height: 40 }), false);
    assert.equal(isValidSlotRect({ x: 20, y: 5, width: undefined, height: 40 }), false);
});

test('isValidSlotRect rejects zero or negative width/height', () => {
    assert.equal(isValidSlotRect({ x: 20, y: 5, width: 0, height: 40 }), false);
    assert.equal(isValidSlotRect({ x: 20, y: 5, width: 280, height: -1 }), false);
});


test('sanitizeRailStatus keeps a known recordErrorKind and drops anything else', () => {
    assert.equal(sanitizeRailStatus({ ...VALID_STATUS, recordErrorKind: 'permission-denied' }).recordErrorKind, 'permission-denied');
    assert.equal(sanitizeRailStatus({ ...VALID_STATUS, recordErrorKind: 'rm -rf' }).recordErrorKind, null);
    const { recordErrorKind: _omit, ...legacy } = VALID_STATUS;
    assert.equal(sanitizeRailStatus(legacy).recordErrorKind, null);
});

test('isValidRailCommand allows only what the dashboard may send', () => {
    for (const action of ['toggleRecord', 'pause', 'resume', 'retryUpload']) {
        assert.equal(isValidRailCommand(action), true, action);
    }
    // Close-flow commands are main-only: a renderer sending them would ack a
    // close handoff main never started.
    for (const action of ['stopForClose', 'retryUploadForClose', 'bogus', 42, null]) {
        assert.equal(isValidRailCommand(action), false, String(action));
    }
});

test('sanitizeRailLevel keeps finite samples, clamps them to 0..1 and caps their number', async () => {
    const { sanitizeRailLevel, RAIL_LEVEL_MAX_SAMPLES } = await import('./railValidation.js');
    assert.deepEqual(sanitizeRailLevel([0.2, -1, 3, NaN, 'x', 0.5]), [0.2, 0, 1, 0.5]);
    assert.equal(sanitizeRailLevel(Array(500).fill(0.1)).length, RAIL_LEVEL_MAX_SAMPLES);
    assert.equal(sanitizeRailLevel('nope'), null);
    assert.equal(sanitizeRailLevel(null), null);
});

test('rail levels are forwarded only while the rail is docked and the dashboard is on screen', async () => {
    const { shouldForwardRailLevel } = await import('./railValidation.js');
    assert.equal(shouldForwardRailLevel({ railVisible: false, dashboardVisible: true, dashboardMinimized: false }), true);
    // Floating rail draws its own meter; hidden/minimized dashboard shows none.
    assert.equal(shouldForwardRailLevel({ railVisible: true, dashboardVisible: true, dashboardMinimized: false }), false);
    assert.equal(shouldForwardRailLevel({ railVisible: false, dashboardVisible: false, dashboardMinimized: false }), false);
    assert.equal(shouldForwardRailLevel({ railVisible: false, dashboardVisible: true, dashboardMinimized: true }), false);
});
