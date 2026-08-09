import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveVenvPython, resolveBackendCommand, startBackend, stopBackend, waitForHealth, getBackendLogTail, armCrashMonitor, disarmCrashMonitor, ensurePortFree, getProcessExecutablePath } from './backend.js';

function makeTmpProjectRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'backend-test-'));
}

test('resolveVenvPython returns null when .venv is missing', () => {
    const projectRoot = makeTmpProjectRoot();
    try {
        assert.equal(resolveVenvPython(projectRoot, 'win32'), null);
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('resolveVenvPython finds .venv/Scripts/python.exe on win32', () => {
    const projectRoot = makeTmpProjectRoot();
    try {
        const scriptsDir = path.join(projectRoot, '.venv', 'Scripts');
        fs.mkdirSync(scriptsDir, { recursive: true });
        const pyPath = path.join(scriptsDir, 'python.exe');
        fs.writeFileSync(pyPath, '');
        assert.equal(resolveVenvPython(projectRoot, 'win32'), pyPath);
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('resolveVenvPython finds .venv/bin/python on posix platforms', () => {
    const projectRoot = makeTmpProjectRoot();
    try {
        const binDir = path.join(projectRoot, '.venv', 'bin');
        fs.mkdirSync(binDir, { recursive: true });
        const pyPath = path.join(binDir, 'python');
        fs.writeFileSync(pyPath, '');
        assert.equal(resolveVenvPython(projectRoot, 'linux'), pyPath);
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('resolveBackendCommand returns the frozen exe in packaged mode on win32', () => {
    const projectRoot = makeTmpProjectRoot();
    try {
        const resourcesPath = path.join(projectRoot, 'resources');
        const result = resolveBackendCommand(projectRoot, resourcesPath, true, 'win32');
        assert.deepEqual(result, {
            command: path.join(resourcesPath, 'backend', 'app-backend.exe'),
            args: [],
            cwd: path.join(resourcesPath, 'backend'),
        });
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('resolveBackendCommand returns the frozen exe (no .exe suffix) in packaged mode on posix', () => {
    const projectRoot = makeTmpProjectRoot();
    try {
        const resourcesPath = path.join(projectRoot, 'resources');
        const result = resolveBackendCommand(projectRoot, resourcesPath, true, 'linux');
        assert.deepEqual(result, {
            command: path.join(resourcesPath, 'backend', 'app-backend'),
            args: [],
            cwd: path.join(resourcesPath, 'backend'),
        });
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('resolveBackendCommand returns the venv python with -m app.server in dev mode', () => {
    const projectRoot = makeTmpProjectRoot();
    try {
        const scriptsDir = path.join(projectRoot, '.venv', 'Scripts');
        fs.mkdirSync(scriptsDir, { recursive: true });
        const pyPath = path.join(scriptsDir, 'python.exe');
        fs.writeFileSync(pyPath, '');

        const result = resolveBackendCommand(projectRoot, path.join(projectRoot, 'resources'), false, 'win32');
        assert.deepEqual(result, {
            command: pyPath,
            args: ['-m', 'app.server'],
            cwd: path.join(projectRoot, 'backend'),
        });
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('resolveBackendCommand returns null in dev mode when .venv is missing', () => {
    const projectRoot = makeTmpProjectRoot();
    try {
        const result = resolveBackendCommand(projectRoot, path.join(projectRoot, 'resources'), false, 'win32');
        assert.equal(result, null);
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('stopBackend is a no-op when no process was started', () => {
    assert.doesNotThrow(() => stopBackend());
});

test('startBackend pipes child stdout through console.log with a [backend] prefix', async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
        const child = startBackend(process.execPath, ['-e', "console.log('hello-from-child')"], process.cwd());
        await new Promise((resolve) => child.once('close', resolve));
    } finally {
        console.log = originalLog;
        stopBackend();
    }
    assert.ok(logs.some((line) => line.includes('[backend]') && line.includes('hello-from-child')));
});

test('startBackend passes a custom env through to the spawned process', async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
        const child = startBackend(
            process.execPath,
            ['-e', 'console.log(process.env.SDD_TEST_VAR)'],
            process.cwd(),
            { ...process.env, SDD_TEST_VAR: 'custom-value' }
        );
        await new Promise((resolve) => child.once('close', resolve));
    } finally {
        console.log = originalLog;
        stopBackend();
    }
    assert.ok(logs.some((line) => line.includes('[backend]') && line.includes('custom-value')));
});

test('stopBackend kills a running process', async () => {
    const child = startBackend(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd());
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await stopBackend();
    await exited;
    assert.notEqual(child.exitCode === null && child.signalCode === null, true);
});

test('waitForHealth resolves once the server responds 2xx on /health', async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        await waitForHealth(`http://127.0.0.1:${port}`, 2000);
    } finally {
        server.close();
    }
});

test('waitForHealth rejects after timeoutMs when nothing responds', async () => {
    await assert.rejects(
        () => waitForHealth('http://127.0.0.1:1', 700),
        /did not become healthy/
    );
});

test('waitForHealth rejects immediately if the child process exits first', async () => {
    const child = startBackend(process.execPath, ['-e', 'process.exit(1)'], process.cwd());
    const start = Date.now();
    await assert.rejects(
        () => waitForHealth('http://127.0.0.1:1', 5000, child),
        /exited before becoming healthy/
    );
    assert.ok(Date.now() - start < 2000, 'should reject quickly, not wait out the full timeout');
    stopBackend();
});

test('getBackendLogTail returns captured stderr output from the spawned process', async () => {
    const child = startBackend(process.execPath, ['-e', "console.error('line1'); console.error('line2')"], process.cwd());
    await new Promise((resolve) => child.once('close', resolve));
    const tail = getBackendLogTail();
    assert.ok(tail.includes('line1'));
    assert.ok(tail.includes('line2'));
    stopBackend();
});

test('getBackendLogTail resets when startBackend is called again', async () => {
    const first = startBackend(process.execPath, ['-e', "console.error('stale-output')"], process.cwd());
    await new Promise((resolve) => first.once('close', resolve));
    assert.ok(getBackendLogTail().includes('stale-output'));

    const second = startBackend(process.execPath, ['-e', "console.error('fresh-output')"], process.cwd());
    await new Promise((resolve) => second.once('close', resolve));
    const tail = getBackendLogTail();
    assert.ok(tail.includes('fresh-output'));
    assert.ok(!tail.includes('stale-output'));
    stopBackend();
});

test('waitForHealth rejects with a specific error when the child process fails to spawn', async () => {
    const child = startBackend('this-command-does-not-exist-xyz', [], process.cwd());
    const start = Date.now();
    await assert.rejects(
        () => waitForHealth('http://127.0.0.1:1', 5000, child),
        /backend process failed to start/
    );
    assert.ok(Date.now() - start < 2000, 'should reject quickly, not wait out the full timeout');
    stopBackend();
});

test('armCrashMonitor invokes onCrash when the process exits unexpectedly', async () => {
    const calls = [];
    const child = startBackend(process.execPath, ['-e', 'process.exit(3)'], process.cwd());
    armCrashMonitor(child, (code, signal) => calls.push({ code, signal }));
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [{ code: 3, signal: null }]);
});

test('armCrashMonitor does not invoke onCrash when stopBackend caused the exit', async () => {
    const calls = [];
    const child = startBackend(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd());
    armCrashMonitor(child, (code, signal) => calls.push({ code, signal }));
    const exited = new Promise((resolve) => child.once('exit', resolve));
    stopBackend();
    await exited;
    assert.deepEqual(calls, []);
});

test('disarmCrashMonitor prevents onCrash from firing', async () => {
    const calls = [];
    const child = startBackend(process.execPath, ['-e', 'process.exit(1)'], process.cwd());
    const listener = armCrashMonitor(child, (code, signal) => calls.push({ code, signal }));
    disarmCrashMonitor(child, listener);
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, []);
});

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close((err) => (err ? reject(err) : resolve(port)));
        });
    });
}

test('ensurePortFree kills a process listening on the given port when it matches expectedExePath (orphaned zombie scenario)', async () => {
    const port = await getFreePort();
    // Spawned directly via child_process, NOT through startBackend/stopBackend — this
    // simulates a backend process orphaned from an earlier, unrelated app launch. Its real
    // executable is process.execPath, so that's passed as expectedExePath to simulate it
    // being recognized as a previous instance of *our* backend.
    const orphan = spawn(process.execPath, [
        '-e',
        `require('node:net').createServer().listen(${port}, '127.0.0.1', () => console.log('listening'));`,
    ]);
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('orphan did not start listening in time')), 3000);
            orphan.stdout.on('data', (data) => {
                if (data.toString().includes('listening')) {
                    clearTimeout(timer);
                    resolve();
                }
            });
        });

        const freed = await ensurePortFree(port, process.execPath, 'win32');
        assert.equal(freed, true);

        assert.ok(orphan.exitCode !== null || orphan.signalCode !== null, 'orphan process should have been killed');

        // Port should now be free: binding a new server on it should succeed.
        const check = net.createServer();
        await new Promise((resolve, reject) => {
            check.once('error', reject);
            check.listen(port, '127.0.0.1', resolve);
        });
        check.close();
    } finally {
        if (orphan.exitCode === null && orphan.signalCode === null) {
            orphan.kill();
        }
    }
});

test('ensurePortFree does not kill a foreign process and reports the port as still occupied', async () => {
    const port = await getFreePort();
    // Same orphan-on-a-port setup as above, but this time it represents some unrelated
    // process (a user's own dev server) -- the mocked lookup always returns a path that
    // does not match expectedExePath, so it must be left alone.
    const foreign = spawn(process.execPath, [
        '-e',
        `require('node:net').createServer().listen(${port}, '127.0.0.1', () => console.log('listening'));`,
    ]);
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('foreign process did not start listening in time')), 3000);
            foreign.stdout.on('data', (data) => {
                if (data.toString().includes('listening')) {
                    clearTimeout(timer);
                    resolve();
                }
            });
        });

        const fakeLookup = async () => 'C:\\Some\\Other\\App\\unrelated.exe';
        const freed = await ensurePortFree(port, 'C:\\Program Files\\App\\app-backend.exe', 'win32', 1000, fakeLookup);

        assert.equal(freed, false);
        assert.equal(foreign.exitCode, null, 'foreign process should not have been killed');
        assert.equal(foreign.signalCode, null, 'foreign process should not have been killed');
    } finally {
        if (foreign.exitCode === null && foreign.signalCode === null) {
            foreign.kill();
        }
    }
});

test('ensurePortFree resolves to true without error when nothing is listening on the port', async () => {
    const port = await getFreePort();
    const freed = await ensurePortFree(port, process.execPath, 'win32');
    assert.equal(freed, true);
});

test('getProcessExecutablePath resolves the real executable path of a running process', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    try {
        await new Promise((resolve) => setTimeout(resolve, 200)); // let the process fully start
        const resolvedPath = await getProcessExecutablePath(child.pid, 'win32');
        assert.equal(path.resolve(resolvedPath).toLowerCase(), path.resolve(process.execPath).toLowerCase());
    } finally {
        child.kill();
    }
});

test('getProcessExecutablePath returns null for a pid that does not exist', async () => {
    const resolvedPath = await getProcessExecutablePath(999999, 'win32');
    assert.equal(resolvedPath, null);
});

function tryBind(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => {
            srv.close(() => resolve(true));
        });
    });
}

// Real-world regression: measured against the actual frozen backend binary,
// the OS took ~600ms to release its listening socket after the process was
// killed — longer than the fixed 300ms wait ensurePortFree used to have.
// A synthetic Node child process can't reproduce this (Windows TerminateProcess
// releases its sockets essentially instantly), so this test spawns the real
// PyInstaller-frozen backend exe to reproduce the exact reported failure. It's
// slow (real cold start + real process teardown) and skipped when the build
// artifact isn't present, but it's the only faithful reproduction of the bug.
const REAL_BACKEND_EXE = path.join(process.cwd(), 'backend-dist', 'app-backend', 'app-backend.exe');
const hasRealBackend = process.platform === 'win32' && fs.existsSync(REAL_BACKEND_EXE);

test(
    'ensurePortFree actually frees the port before returning, even against the real backend binary\'s slower socket release',
    { skip: !hasRealBackend ? 'backend-dist/app-backend/app-backend.exe not built' : false, timeout: 30000 },
    async () => {
        const port = await getFreePort();
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-timing-test-'));
        const child = spawn(REAL_BACKEND_EXE, [], {
            cwd: path.dirname(REAL_BACKEND_EXE),
            env: { ...process.env, PORT: String(port), APP_DATA_DIR: dataDir },
        });
        try {
            // Cold start can take several seconds; poll until it actually binds.
            const bindDeadline = Date.now() + 20000;
            let boundOk = false;
            while (Date.now() < bindDeadline) {
                if (!(await tryBind(port))) {
                    boundOk = true;
                    break;
                }
                await new Promise((r) => setTimeout(r, 200));
            }
            assert.ok(boundOk, 'real backend never bound to the test port within 20s');

            const freed = await ensurePortFree(port, REAL_BACKEND_EXE, 'win32');
            assert.equal(freed, true);

            // The whole point: by the time ensurePortFree resolves, the port
            // must actually be free — not just "probably free after a guess".
            const freeNow = await tryBind(port);
            assert.ok(freeNow, 'port should be bindable immediately after ensurePortFree resolves');
        } finally {
            fs.rmSync(dataDir, { recursive: true, force: true });
            if (child.exitCode === null && child.signalCode === null) {
                child.kill();
            }
        }
    }
);
