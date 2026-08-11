import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasSeenRecordingConsentNotice, markRecordingConsentNoticeSeen } from './consentStore.js';

function makeTmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-store-test-'));
    return path.join(dir, 'consent.json');
}

test('hasSeenRecordingConsentNotice returns false when the file does not exist', () => {
    const filePath = makeTmpFile();
    assert.equal(hasSeenRecordingConsentNotice(filePath), false);
});

test('hasSeenRecordingConsentNotice returns false for a corrupt file', () => {
    const filePath = makeTmpFile();
    fs.writeFileSync(filePath, 'not json');
    assert.equal(hasSeenRecordingConsentNotice(filePath), false);
});

test('markRecordingConsentNoticeSeen creates the directory and file', () => {
    const filePath = makeTmpFile();
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    markRecordingConsentNoticeSeen(filePath);
    assert.equal(hasSeenRecordingConsentNotice(filePath), true);
});

test('hasSeenRecordingConsentNotice returns true after marking seen', () => {
    const filePath = makeTmpFile();
    assert.equal(hasSeenRecordingConsentNotice(filePath), false);
    markRecordingConsentNoticeSeen(filePath);
    assert.equal(hasSeenRecordingConsentNotice(filePath), true);
});
