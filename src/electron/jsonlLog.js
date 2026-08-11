import fs from 'node:fs';
import path from 'node:path';

// Appends a single JSON-line record to `filename` inside `logDir`, creating
// the directory if needed -- shared by crashLog.js and backendRecovery.js so
// a future change (atomic writes, rotation) only needs to land once.
export function appendJsonLine(logDir, filename, payload) {
    fs.mkdirSync(logDir, { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...payload });
    fs.appendFileSync(path.join(logDir, filename), line + '\n');
}
