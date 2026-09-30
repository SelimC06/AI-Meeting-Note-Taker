import { test } from 'node:test';
import assert from 'node:assert/strict';
import afterSign, { isAdHocSigned } from './notarize.mjs';

function context(identity) {
    return {
        electronPlatformName: 'darwin',
        appOutDir: '/nonexistent',
        packager: {
            platformSpecificBuildOptions: { identity },
            appInfo: { productFilename: 'DeskRecap', id: 'com.meetingnotetaker.app' },
        },
    };
}

test('an ad-hoc build (identity "-") is recognised', () => {
    assert.equal(isAdHocSigned(context('-')), true);
    assert.equal(isAdHocSigned(context('Developer ID Application: X')), false);
});

test('afterSign never notarizes an ad-hoc build, even with APPLE_API_* set', async () => {
    const saved = { ...process.env };
    process.env.APPLE_API_KEY = '/tmp/AuthKey_TEST.p8';
    process.env.APPLE_API_KEY_ID = 'TEST';
    process.env.APPLE_API_ISSUER = '00000000-0000-0000-0000-000000000000';
    const logs = [];
    const originalLog = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
        // Would reject (bogus key, missing app) if it tried to notarize.
        await afterSign(context('-'));
    } finally {
        console.log = originalLog;
        process.env = saved;
    }
    assert.ok(logs.some((l) => l.includes('ad-hoc-signed build')));
});
