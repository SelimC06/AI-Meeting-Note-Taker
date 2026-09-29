import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAC_LOOPBACK_FEATURES, mergeEnableFeatures, sanitizeCaptureMode } from './captureMode.js';

test('sanitizeCaptureMode passes through known modes', () => {
    assert.equal(sanitizeCaptureMode('picker'), 'picker');
    assert.equal(sanitizeCaptureMode('audioOnly'), 'audioOnly');
});

test('sanitizeCaptureMode falls back to the picker for anything else', () => {
    assert.equal(sanitizeCaptureMode('evil'), 'picker');
    assert.equal(sanitizeCaptureMode(undefined), 'picker');
    assert.equal(sanitizeCaptureMode({}), 'picker');
});

test('mergeEnableFeatures keeps existing features and appends new ones once', () => {
    assert.equal(mergeEnableFeatures('', ['A', 'B']), 'A,B');
    assert.equal(mergeEnableFeatures(undefined, ['A']), 'A');
    assert.equal(mergeEnableFeatures('X,A', ['A', 'B']), 'X,A,B');
});

test('MAC_LOOPBACK_FEATURES enables ScreenCaptureKit system-audio loopback', () => {
    assert.deepEqual(MAC_LOOPBACK_FEATURES, ['MacLoopbackAudioForScreenShare', 'MacSckSystemAudioLoopbackOverride']);
});
