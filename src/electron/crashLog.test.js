import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
    appendCrashLog,
    armProcessCrashLogging,
    logRendererCrash,
    logRendererError,
    RENDERER_ERROR_FIELD_MAX_CHARS,
    RENDERER_ERRORS_LOG_MAX_BYTES,
} from './crashLog.js';

function makeTmpLogDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'crash-log-test-'));
}

function readLines(logDir, filename) {
    const filePath = path.join(logDir, filename);
    return fs.readFileSync(filePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('appendCrashLog creates the log directory and appends a JSON line with a timestamp', () => {
    const logDir = makeTmpLogDir();
    try {
        appendCrashLog(logDir, 'test.log', { kind: 'thing', message: 'boom' });
        const [line] = readLines(logDir, 'test.log');
        assert.equal(line.kind, 'thing');
        assert.equal(line.message, 'boom');
        assert.ok(typeof line.timestamp === 'string' && line.timestamp.length > 0);
    } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('appendCrashLog appends multiple lines across calls', () => {
    const logDir = makeTmpLogDir();
    try {
        appendCrashLog(logDir, 'test.log', { n: 1 });
        appendCrashLog(logDir, 'test.log', { n: 2 });
        const lines = readLines(logDir, 'test.log');
        assert.equal(lines.length, 2);
        assert.equal(lines[0].n, 1);
        assert.equal(lines[1].n, 2);
    } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('armProcessCrashLogging logs an uncaughtException with message and stack, then exits', () => {
    const logDir = makeTmpLogDir();
    try {
        const fakeProcess = new EventEmitter();
        let exitCode = null;
        fakeProcess.exit = (code) => { exitCode = code; };

        armProcessCrashLogging(logDir, fakeProcess);
        fakeProcess.emit('uncaughtException', new Error('kaboom'));

        const [line] = readLines(logDir, 'main-crashes.log');
        assert.equal(line.kind, 'uncaughtException');
        assert.equal(line.message, 'kaboom');
        assert.ok(line.stack.includes('kaboom'));
        assert.equal(exitCode, 1);
    } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('armProcessCrashLogging logs an unhandledRejection without exiting', () => {
    const logDir = makeTmpLogDir();
    try {
        const fakeProcess = new EventEmitter();
        let exited = false;
        fakeProcess.exit = () => { exited = true; };

        armProcessCrashLogging(logDir, fakeProcess);
        fakeProcess.emit('unhandledRejection', new Error('rejected'));

        const [line] = readLines(logDir, 'main-crashes.log');
        assert.equal(line.kind, 'unhandledRejection');
        assert.equal(line.message, 'rejected');
        assert.equal(exited, false);
    } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('armProcessCrashLogging handles a non-Error rejection reason', () => {
    const logDir = makeTmpLogDir();
    try {
        const fakeProcess = new EventEmitter();
        fakeProcess.exit = () => {};

        armProcessCrashLogging(logDir, fakeProcess);
        fakeProcess.emit('unhandledRejection', 'just a string reason');

        const [line] = readLines(logDir, 'main-crashes.log');
        assert.equal(line.message, 'just a string reason');
    } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('logRendererCrash appends a render-process-gone record', () => {
    const logDir = makeTmpLogDir();
    try {
        logRendererCrash(logDir, { reason: 'oom', exitCode: -1 });
        const [line] = readLines(logDir, 'renderer-crashes.log');
        assert.equal(line.kind, 'render-process-gone');
        assert.equal(line.reason, 'oom');
        assert.equal(line.exitCode, -1);
    } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('logRendererCrash ignores benign render-process-gone reasons', () => {
    const logDir = makeTmpLogDir();
    try {
        logRendererCrash(logDir, { reason: 'clean-exit', exitCode: 0 });
        logRendererCrash(logDir, { reason: 'killed', exitCode: 0 });
        assert.equal(fs.existsSync(path.join(logDir, 'renderer-crashes.log')), false);

        logRendererCrash(logDir, { reason: 'crashed', exitCode: -1 });
        const [line] = readLines(logDir, 'renderer-crashes.log');
        assert.equal(line.reason, 'crashed');
    } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('logRendererError appends a renderer JS error record', () => {
    const logDir = makeTmpLogDir();
    try {
        logRendererError(logDir, { kind: 'window.onerror', message: 'undefined is not a function', stack: 'at foo.tsx:12' });
        const [line] = readLines(logDir, 'renderer-errors.log');
        assert.equal(line.kind, 'window.onerror');
        assert.equal(line.message, 'undefined is not a function');
        assert.equal(line.stack, 'at foo.tsx:12');
    } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});


test('armProcessCrashLogging runs the beforeExit hook (backend kill) before exiting', () => {
    const logDir = makeTmpLogDir();
    try {
        const fakeProcess = new EventEmitter();
        const order = [];
        fakeProcess.exit = (code) => order.push(`exit ${code}`);

        armProcessCrashLogging(logDir, fakeProcess, { beforeExit: () => order.push('kill backend') });
        fakeProcess.emit('uncaughtException', new Error('kaboom'));

        assert.deepEqual(order, ['kill backend', 'exit 1']);
    } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('armProcessCrashLogging still exits when the log write and the hook both throw', () => {
    const fakeProcess = new EventEmitter();
    let exitCode = null;
    fakeProcess.exit = (code) => { exitCode = code; };
    // A regular file where the log DIRECTORY should be: mkdir/append fail.
    const notADir = path.join(makeTmpLogDir(), 'file');
    fs.writeFileSync(notADir, '');
    const originalError = console.error;
    console.error = () => {};
    try {
        armProcessCrashLogging(notADir, fakeProcess, { beforeExit: () => { throw new Error('hook failed'); } });
        assert.doesNotThrow(() => fakeProcess.emit('uncaughtException', new Error('kaboom')));
        assert.equal(exitCode, 1);
    } finally {
        console.error = originalError;
        fs.rmSync(path.dirname(notADir), { recursive: true, force: true });
    }
});

test('logRendererError drops a non-object payload instead of throwing', () => {
    const logDir = makeTmpLogDir();
    try {
        for (const bad of [null, undefined, 'string', 42]) {
            assert.equal(logRendererError(logDir, bad), false);
        }
        assert.equal(fs.existsSync(path.join(logDir, 'renderer-errors.log')), false);
    } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('logRendererError coerces field types and caps their length', () => {
    const logDir = makeTmpLogDir();
    try {
        logRendererError(logDir, { kind: { evil: true }, message: 'm'.repeat(10000), stack: 12 });
        const [line] = readLines(logDir, 'renderer-errors.log');
        assert.equal(line.kind, 'unknown');
        assert.ok(line.message.length <= RENDERER_ERROR_FIELD_MAX_CHARS.message + 1);
        assert.equal(line.stack, null);
    } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});

test('logRendererError returns false instead of throwing when the log cannot be written', () => {
    const base = makeTmpLogDir();
    const notADir = path.join(base, 'file');
    fs.writeFileSync(notADir, '');
    const originalError = console.error;
    console.error = () => {};
    try {
        assert.equal(logRendererError(notADir, { kind: 'x', message: 'y' }), false);
    } finally {
        console.error = originalError;
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('renderer-errors.log rotates once it reaches its size cap', () => {
    const logDir = makeTmpLogDir();
    try {
        const filePath = path.join(logDir, 'renderer-errors.log');
        fs.writeFileSync(filePath, 'x'.repeat(RENDERER_ERRORS_LOG_MAX_BYTES));

        logRendererError(logDir, { kind: 'window.onerror', message: 'after rotation' });

        assert.equal(fs.statSync(`${filePath}.1`).size, RENDERER_ERRORS_LOG_MAX_BYTES);
        const lines = readLines(logDir, 'renderer-errors.log');
        assert.equal(lines.length, 1);
        assert.equal(lines[0].message, 'after rotation');
    } finally {
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});
