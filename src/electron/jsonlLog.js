import fs from 'node:fs';
import path from 'node:path';

// Appends a single JSON-line record to `filename` inside `logDir`, creating
// the directory if needed -- shared by crashLog.js and backendRecovery.js so
// a future change (atomic writes, rotation) only needs to land once.
//
// maxBytes (optional): once the file has reached this size, it's renamed to
// `<filename>.1` (replacing any previous one) before appending, so a log
// that something can write to in a loop -- a renderer throwing on every
// frame -- is capped at about 2x maxBytes instead of filling the disk.
export function appendJsonLine(logDir, filename, payload, { maxBytes = null } = {}) {
    fs.mkdirSync(logDir, { recursive: true });
    const filePath = path.join(logDir, filename);
    if (maxBytes !== null) {
        let size = 0;
        try {
            size = fs.statSync(filePath).size;
        } catch {
            // no file yet
        }
        if (size >= maxBytes) {
            fs.renameSync(filePath, `${filePath}.1`);
        }
    }
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...payload });
    fs.appendFileSync(filePath, line + '\n');
}
