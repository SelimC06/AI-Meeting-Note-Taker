import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_CAPTURE_SOURCE_TYPES, sanitizeCaptureSourceTypes } from './captureSources.js';

test('sanitizeCaptureSourceTypes passes through allowed types unchanged', () => {
    assert.deepEqual(sanitizeCaptureSourceTypes(['screen', 'window']), ['screen', 'window']);
    assert.deepEqual(sanitizeCaptureSourceTypes(['screen']), ['screen']);
});

test('sanitizeCaptureSourceTypes drops any value outside the allowlist', () => {
    assert.deepEqual(sanitizeCaptureSourceTypes(['screen', 'evil', 'window']), ['screen', 'window']);
    assert.deepEqual(sanitizeCaptureSourceTypes(['not-a-real-type']), []);
});

test('sanitizeCaptureSourceTypes falls back to the full allowlist for non-array input', () => {
    assert.deepEqual(sanitizeCaptureSourceTypes(undefined), ALLOWED_CAPTURE_SOURCE_TYPES);
    assert.deepEqual(sanitizeCaptureSourceTypes(null), ALLOWED_CAPTURE_SOURCE_TYPES);
    assert.deepEqual(sanitizeCaptureSourceTypes('screen'), ALLOWED_CAPTURE_SOURCE_TYPES);
});

test('ALLOWED_CAPTURE_SOURCE_TYPES is exactly screen and window', () => {
    assert.deepEqual(ALLOWED_CAPTURE_SOURCE_TYPES, ['screen', 'window']);
});
