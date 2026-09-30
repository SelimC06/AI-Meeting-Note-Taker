import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logCrash, attemptRecovery, isRecovering } from './backendRecovery.js';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { startBackend, stopBackend } from './backend.js';

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

test('attemptRecovery invokes onStatus with the same payloads sent to the window (G2 fix)', async () => {
    // main.js relies on onStatus to keep its lastBackendStatus cache
    // authoritative -- and to stop the health watchdog once a cycle lands
    // on "failed" -- so this side-channel must fire for every state the
    // window itself receives, not a subset.
    const port = await findFreePort();
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-recovery-test-'));
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-recovery-marker-'));
    const marker = path.join(markerDir, 'ready');
    const win = makeFakeWindow();
    const onStatusCalls = [];
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
            onStatus: (payload) => onStatusCalls.push(payload),
        });
        setTimeout(() => fs.writeFileSync(marker, ''), 30);
        await recoveryPromise;

        assert.deepEqual(onStatusCalls, win.sent.map((s) => s.payload));
    } finally {
        stopBackend();
        fs.rmSync(logDir, { recursive: true, force: true });
        fs.rmSync(markerDir, { recursive: true, force: true });
    }
});

test('attemptRecovery still reports every status via onStatus when given no window', async () => {
    // main.js no longer hands attemptRecovery a window at all (a captured
    // one went stale once the dashboard was recreated) -- it relies solely
    // on onStatus to reach whichever windows are current at send time.
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-recovery-test-'));
    const onStatusCalls = [];
    try {
        await attemptRecovery({
            pythonExe: process.execPath,
            args: ['-e', 'process.exit(1)'],
            cwd: process.cwd(),
            env: process.env,
            backendUrl: 'http://127.0.0.1:1',
            logDir,
            crashInfo: { exitCode: 1, signal: null },
            delays: [0, 10, 10],
            onStatus: (payload) => onStatusCalls.push(payload),
        });

        assert.deepEqual(onStatusCalls.map((p) => p.state), ['restarting', 'restarting', 'restarting', 'failed']);
    } finally {
        stopBackend();
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('attemptRecovery calls onStatus with "failed" when every attempt is exhausted', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-recovery-test-'));
    const win = makeFakeWindow();
    const onStatusCalls = [];
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
            onStatus: (payload) => onStatusCalls.push(payload),
        });

        assert.equal(onStatusCalls[onStatusCalls.length - 1].state, 'failed');
    } finally {
        stopBackend();
        fs.rmSync(logDir, { recursive: true, force: true });
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

// Resolves false once `pid` is gone, or true if it is still running at the deadline.
async function waitForPidGone(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            process.kill(pid, 0);
        } catch {
            return false;
        }
        if (Date.now() >= deadline) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

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
            // Poll rather than probing once: stopBackend's POSIX path sends SIGTERM and
            // returns without waiting for the signal to actually be delivered, so the
            // last attempt's child -- killed microseconds before this assertion -- is
            // still briefly alive. (On Windows `taskkill /F` blocks until the process is
            // gone, which is why a single instant probe only ever passed there.) The
            // invariant under test is that no child is left orphaned, not that the kill
            // is synchronous, so give delivery a bounded window to land.
            const alive = await waitForPidGone(pid, 5000);
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

const ZOMBIE_HEALTH_SCRIPT = `
const http = require('http');
const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); res.end('{"ok":true,"zombie":true}'); }
    else { res.writeHead(404); res.end(); }
});
server.listen(Number(process.env.SDD_PORT), '127.0.0.1', () => console.log('zombie-listening'));
`;

const REAL_BACKEND_SCRIPT = `
const http = require('http');
const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); res.end('{"ok":true}'); }
    else { res.writeHead(404); res.end(); }
});
server.on('error', (err) => { console.error('bind failed: ' + err.message); process.exit(1); });
server.listen(Number(process.env.SDD_PORT), '127.0.0.1');
`;

test('attemptRecovery clears a stale orphaned process squatting on the port before spawning', async () => {
    const port = await findFreePort();
    const logDir = makeTmpLogDir();
    const win = makeFakeWindow();
    // Spawned directly, not through startBackend — simulates a backend process
    // orphaned from an earlier, unrelated app launch that never released the port.
    const zombie = spawn(process.execPath, ['-e', ZOMBIE_HEALTH_SCRIPT], {
        env: { ...process.env, SDD_PORT: String(port) },
    });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('zombie did not start listening in time')), 3000);
            zombie.stdout.on('data', (data) => {
                if (data.toString().includes('zombie-listening')) {
                    clearTimeout(timer);
                    resolve();
                }
            });
        });

        await attemptRecovery({
            pythonExe: process.execPath,
            args: ['-e', REAL_BACKEND_SCRIPT],
            cwd: process.cwd(),
            env: { ...process.env, SDD_PORT: String(port) },
            backendUrl: `http://127.0.0.1:${port}`,
            mainWindow: win,
            logDir,
            crashInfo: { exitCode: 1, signal: null },
            delays: [0, 100],
        });

        const states = win.sent.map((s) => s.payload.state);
        assert.equal(
            states[states.length - 1],
            'up',
            'recovery should succeed once the stale zombie is cleared from the port instead of looping forever'
        );

        // Confirm the health endpoint is now served by the freshly spawned
        // backend, not the zombie (which would still be alive and answering
        // without the fix, masking the fact that the real backend never bound).
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        const body = await res.json();
        assert.equal(body.zombie, undefined);
    } finally {
        if (zombie.exitCode === null && zombie.signalCode === null) {
            zombie.kill();
        }
        stopBackend();
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('attemptRecovery aborts immediately without spawning a backend when isShuttingDown() is already true', async () => {
    const logDir = makeTmpLogDir();
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
            isShuttingDown: () => true,
        });
        assert.deepEqual(win.sent, []);
        assert.equal(isRecovering(), false);
    } finally {
        stopBackend();
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('attemptRecovery kills the just-spawned child and bails when isShuttingDown() flips true right after the spawn (zombie-after-quit race)', async () => {
    // Reproduces the 2D race: quit begins between the pre-spawn check and the
    // spawn itself (before-quit's stopBackend already ran against the
    // *previous* process), so without a post-spawn re-check this child would
    // never be killed and would outlive the app.
    const port = await findFreePort();
    const logDir = makeTmpLogDir();
    const win = makeFakeWindow();
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-recovery-marker-'));
    const marker = path.join(markerDir, 'ready');
    fs.writeFileSync(marker, '');
    let calls = 0;
    // False through the pre-spawn checks (top-of-function, top-of-loop,
    // post-delay); true from the first check made after startBackend runs
    // (the new post-spawn re-check this fix adds) onward.
    const isShuttingDown = () => {
        calls += 1;
        return calls > 3;
    };
    try {
        await attemptRecovery({
            pythonExe: process.execPath,
            args: ['-e', HEALTH_SERVER_SCRIPT],
            cwd: process.cwd(),
            env: { ...process.env, SDD_MARKER: marker, SDD_PORT: String(port) },
            backendUrl: `http://127.0.0.1:${port}`,
            mainWindow: win,
            logDir,
            crashInfo: { exitCode: 1, signal: null },
            delays: [0],
            isShuttingDown,
        });

        assert.equal(win.sent.length, 1, 'expected only the "restarting" publish -- no "up" after a post-spawn shutdown');
        assert.equal(win.sent[0].payload.state, 'restarting');
        assert.equal(isRecovering(), false);

        // Give the spawned child a moment to have bound the port if it was
        // somehow left running, then confirm nothing is listening -- proof
        // the post-spawn shutdown check actually killed it instead of
        // leaving a zombie backend holding the port past this "quit".
        await new Promise((resolve) => setTimeout(resolve, 500));
        await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }));
    } finally {
        stopBackend();
        fs.rmSync(logDir, { recursive: true, force: true });
        fs.rmSync(markerDir, { recursive: true, force: true });
    }
});

test('attemptRecovery stops between attempts once isShuttingDown() flips true, instead of spawning another backend', async () => {
    const logDir = makeTmpLogDir();
    const win = makeFakeWindow();
    let shuttingDown = false;
    try {
        const recoveryPromise = attemptRecovery({
            pythonExe: process.execPath,
            args: ['-e', 'process.exit(1)'],
            cwd: process.cwd(),
            env: process.env,
            backendUrl: 'http://127.0.0.1:1',
            mainWindow: win,
            logDir,
            crashInfo: { exitCode: 1, signal: null },
            delays: [0, 300, 300],
            isShuttingDown: () => shuttingDown,
        });
        // Attempt 1 fires immediately and fails fast (the child exits(1) right
        // away). Flip the flag partway through attempt 2's 300ms backoff so the
        // loop aborts before spawning a second backend process.
        setTimeout(() => { shuttingDown = true; }, 100);
        await recoveryPromise;

        const states = win.sent.map((s) => s.payload.state);
        assert.equal(states.filter((s) => s === 'restarting').length, 1);
        assert.ok(!states.includes('failed'), 'should abort quietly, not report failure once quitting has begun');
        assert.equal(isRecovering(), false);
    } finally {
        stopBackend();
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});


test('attemptRecovery stops a still-tracked backend that never bound the port before spawning (Retry after startup timeout)', { skip: process.platform === 'win32' }, async () => {
    const port = await findFreePort();
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-recovery-test-'));
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-recovery-marker-'));
    const marker = path.join(markerDir, 'ready');
    fs.writeFileSync(marker, '');
    // The slow starter: alive, not listening (so ensurePortFree can't see
    // it), and ignoring SIGTERM like a wedged uvicorn.
    const stale = startBackend(
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000);"],
        process.cwd()
    );
    await new Promise((resolve) => stale.stdout.once('data', resolve));
    const staleExited = new Promise((resolve) => stale.once('exit', (code, signal) => resolve(signal)));
    try {
        await attemptRecovery({
            pythonExe: process.execPath,
            args: ['-e', HEALTH_SERVER_SCRIPT],
            cwd: process.cwd(),
            env: { ...process.env, SDD_MARKER: marker, SDD_PORT: String(port) },
            backendUrl: `http://127.0.0.1:${port}`,
            logDir,
            delays: [0],
        });
        // Resolved by the time recovery finished -- stopped (SIGKILL after
        // the grace period), not left running untracked.
        assert.equal(await Promise.race([staleExited, new Promise((r) => setTimeout(() => r('still running'), 100))]), 'SIGKILL');
    } finally {
        await stopBackend();
        fs.rmSync(logDir, { recursive: true, force: true });
        fs.rmSync(markerDir, { recursive: true, force: true });
    }
});
