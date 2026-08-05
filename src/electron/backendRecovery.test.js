import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logCrash, attemptRecovery, isRecovering } from './backendRecovery.js';
import net from 'node:net';
import { stopBackend } from './backend.js';

function makeTmpLogDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'backend-recovery-test-'));
}

test('logCrash creates the log directory and appends a JSON line', () => {
    const logDir = makeTmpLogDir();
    try {
        logCrash(logDir, { exitCode: 1, signal: null, logTail: 'Traceback...' });
        const filePath = path.join(logDir, 'backend-crashes.log');
        const contents = fs.readFileSync(filePath, 'utf8').trim();
        const line = JSON.parse(contents);
        assert.equal(line.exitCode, 1);
        assert.equal(line.signal, null);
        assert.equal(line.logTail, 'Traceback...');
        assert.ok(typeof line.timestamp === 'string' && line.timestamp.length > 0);
    } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('logCrash appends multiple lines across calls', () => {
    const logDir = makeTmpLogDir();
    try {
        logCrash(logDir, { exitCode: 1, signal: null, logTail: 'first' });
        logCrash(logDir, { exitCode: 2, signal: null, logTail: 'second' });
        const filePath = path.join(logDir, 'backend-crashes.log');
        const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
        assert.equal(lines.length, 2);
        assert.equal(JSON.parse(lines[0]).logTail, 'first');
        assert.equal(JSON.parse(lines[1]).logTail, 'second');
    } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

function makeFakeWindow() {
    const sent = [];
    return {
        isDestroyed: () => false,
        webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
        sent,
    };
}

function findFreePort() {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

const HEALTH_SERVER_SCRIPT = `
const http = require('http');
const fs = require('fs');
const marker = process.env.SDD_MARKER;
if (!fs.existsSync(marker)) { process.exit(1); }
const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); res.end('{"ok":true}'); }
    else { res.writeHead(404); res.end(); }
});
server.listen(Number(process.env.SDD_PORT), '127.0.0.1');
`;

test('attemptRecovery restarts successfully on a later attempt', async () => {
    const port = await findFreePort();
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-recovery-test-'));
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-recovery-marker-'));
    const marker = path.join(markerDir, 'ready');
    const win = makeFakeWindow();
    try {
        const recoveryPromise = attemptRecovery({
            pythonExe: process.execPath,
            args: ['-e', HEALTH_SERVER_SCRIPT],
            cwd: process.cwd(),
            env: { ...process.env, SDD_MARKER: marker, SDD_PORT: String(port) },
            backendUrl: `http://127.0.0.1:${port}`,
            mainWindow: win,
            logDir,
            crashInfo: { exitCode: 1, signal: null },
            delays: [0, 100, 100],
        });
        // Attempt 1 (delay 0) spawns immediately and fails because the marker
        // doesn't exist yet; create it during the 100ms backoff before attempt 2.
        setTimeout(() => fs.writeFileSync(marker, ''), 30);
        await recoveryPromise;

        const states = win.sent.map((s) => s.payload.state);
        assert.ok(states.includes('restarting'));
        assert.equal(states[states.length - 1], 'up');

        const crashLog = fs.readFileSync(path.join(logDir, 'backend-crashes.log'), 'utf8').trim();
        assert.equal(crashLog.split('\n').length, 1);
    } finally {
        stopBackend();
        fs.rmSync(logDir, { recursive: true, force: true });
        fs.rmSync(markerDir, { recursive: true, force: true });
    }
});

test('attemptRecovery reports failed after exhausting all attempts', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-recovery-test-'));
    const win = makeFakeWindow();
    try {
        await attemptRecovery({
            pythonExe: process.execPath,
            args: ['-e', 'process.exit(1)'],
            cwd: process.cwd(),
            env: process.env,
            backendUrl: 'http://127.0.0.1:1',
            mainWindow: win,
            logDir,
            crashInfo: { exitCode: 1, signal: null },
            delays: [0, 10, 10],
        });
        const states = win.sent.map((s) => s.payload.state);
        assert.equal(states[states.length - 1], 'failed');
        assert.equal(states.filter((s) => s === 'restarting').length, 3);
    } finally {
        stopBackend();
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('attemptRecovery kills a failed attempt\'s child before the next attempt starts (no orphaned process)', async () => {
    const logDir = makeTmpLogDir();
    const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-recovery-pids-'));
    const pidFile = path.join(pidDir, 'pids.txt');
    fs.writeFileSync(pidFile, '');
    const win = makeFakeWindow();
    // Spawns a process that appends its own PID to a shared file and then
    // stays alive indefinitely (never becomes healthy, never exits on its own).
    // This lets us verify each failed attempt's child is actually killed
    // rather than left running (orphaned) when the next attempt spawns.
    const LONG_RUNNING_SCRIPT = `
const fs = require('fs');
fs.appendFileSync(process.env.SDD_PIDFILE, process.pid + '\\n');
setInterval(() => {}, 1000);
`;
    try {
        await attemptRecovery({
            pythonExe: process.execPath,
            args: ['-e', LONG_RUNNING_SCRIPT],
            cwd: process.cwd(),
            env: { ...process.env, SDD_PIDFILE: pidFile },
            // unreachable: connection is refused, so waitForHealth can only ever
            // fail via its timeout, never via the child exiting on its own.
            backendUrl: 'http://127.0.0.1:1',
            mainWindow: win,
            logDir,
            crashInfo: null,
            delays: [0, 100],
            healthTimeoutMs: 100,
        });

        const states = win.sent.map((s) => s.payload.state);
        assert.equal(states[states.length - 1], 'failed');

        const pids = fs.readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number);
        assert.equal(pids.length, 2, 'expected both attempts to have spawned a child process');
        for (const pid of pids) {
            let alive = true;
            try {
                process.kill(pid, 0);
            } catch {
                alive = false;
            }
            assert.equal(alive, false, `expected child pid ${pid} to have been killed after its attempt failed, but it is still running`);
        }
    } finally {
        stopBackend();
        // Best-effort cleanup so a regression in the fix doesn't leave stray
        // processes running after the test suite exits.
        try {
            const pids = fs.readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number);
            for (const pid of pids) {
                try { process.kill(pid); } catch { /* already dead */ }
            }
        } catch { /* pid file may not exist */ }
        fs.rmSync(logDir, { recursive: true, force: true });
        fs.rmSync(pidDir, { recursive: true, force: true });
    }
});

test('attemptRecovery survives a crash-log write failure and still attempts recovery', async () => {
    const logDirParent = makeTmpLogDir();
    // Make logDir point at a file instead of a directory, so logCrash's
    // fs.mkdirSync(logDir, { recursive: true }) throws (e.g. ENOTDIR),
    // simulating a disk-full/permissions failure while writing the crash log.
    const logDir = path.join(logDirParent, 'not-a-directory');
    fs.writeFileSync(logDir, 'this is a file, not a directory');
    const win = makeFakeWindow();
    try {
        await assert.doesNotReject(() =>
            attemptRecovery({
                pythonExe: process.execPath,
                args: ['-e', 'process.exit(1)'],
                cwd: process.cwd(),
                env: process.env,
                backendUrl: 'http://127.0.0.1:1',
                mainWindow: win,
                logDir,
                crashInfo: { exitCode: 1, signal: null },
                delays: [0, 10],
            })
        );

        const states = win.sent.map((s) => s.payload.state);
        assert.ok(
            states.includes('restarting'),
            'expected attemptRecovery to proceed into the restart loop despite the crash-log write failure'
        );
        assert.equal(states[states.length - 1], 'failed');
    } finally {
        stopBackend();
        fs.rmSync(logDirParent, { recursive: true, force: true });
    }
});

test('attemptRecovery ignores overlapping calls while a recovery is in progress', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-recovery-test-'));
    const win = makeFakeWindow();
    try {
        const first = attemptRecovery({
            pythonExe: process.execPath,
            args: ['-e', 'process.exit(1)'],
            cwd: process.cwd(),
            env: process.env,
            backendUrl: 'http://127.0.0.1:1',
            mainWindow: win,
            logDir,
            crashInfo: { exitCode: 1, signal: null },
            delays: [0, 10, 10],
        });
        assert.equal(isRecovering(), true);
        await attemptRecovery({
            pythonExe: process.execPath,
            args: ['-e', 'process.exit(1)'],
            cwd: process.cwd(),
            env: process.env,
            backendUrl: 'http://127.0.0.1:1',
            mainWindow: win,
            logDir,
            crashInfo: { exitCode: 1, signal: null },
            delays: [0],
        });
        await first;
        assert.equal(isRecovering(), false);
        // only one crash line: the overlapping call returned immediately without logging
        const crashLog = fs.readFileSync(path.join(logDir, 'backend-crashes.log'), 'utf8').trim();
        assert.equal(crashLog.split('\n').length, 1);
    } finally {
        stopBackend();
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});
