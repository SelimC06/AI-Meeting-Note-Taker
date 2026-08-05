import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { resolveVenvPython, startBackend, stopBackend, waitForHealth, getBackendLogTail } from './backend.js';

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
    stopBackend();
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
