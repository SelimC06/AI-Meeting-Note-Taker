import fs from 'node:fs';
import path from 'node:path';

// Whether the user has ever confirmed the one-time "let people know they're
// being recorded" notice. Missing/corrupt file reads as false (never
// shown) rather than throwing -- a fresh install or a hand-edited file
// should fail safe toward showing the notice again, not toward skipping it.
export function hasSeenRecordingConsentNotice(filePath) {
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return data?.hasSeenRecordingConsentNotice === true;
    } catch {
        return false;
    }
}

export function markRecordingConsentNoticeSeen(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ hasSeenRecordingConsentNotice: true }));
}
