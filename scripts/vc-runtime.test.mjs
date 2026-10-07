import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleVcRuntime, compareVersions, peFileVersion, VC_RUNTIME_DLLS } from './vc-runtime.mjs';
import { ensureVcRuntime } from './check-extra-resources.mjs';

// A fake PE "file": padding, the VS_FIXEDFILEINFO signature, then
// dwStrucVersion, dwFileVersionMS, dwFileVersionLS.
function fakeDll([a, b, c, d], tag = '') {
    const buf = Buffer.alloc(64);
    buf.write(`MZ${tag}`, 0);
    buf.set([0xbd, 0x04, 0xef, 0xfe], 20);
    buf.writeUInt32LE(0x00010000, 24);
    buf.writeUInt32LE(((a << 16) | b) >>> 0, 28);
    buf.writeUInt32LE(((c << 16) | d) >>> 0, 32);
    return buf;
}

function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'vc-runtime-'));
}

function writeAll(dir, version, tag) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of VC_RUNTIME_DLLS) fs.writeFileSync(path.join(dir, name), fakeDll(version, tag));
}

test('peFileVersion reads the fixed file version; null without a version resource', () => {
    assert.deepEqual(peFileVersion(fakeDll([14, 44, 35211, 0])), [14, 44, 35211, 0]);
    assert.equal(peFileVersion(Buffer.from('MZ no version here')), null);
});

test('compareVersions orders by each field', () => {
    assert.ok(compareVersions([14, 44, 1, 0], [14, 38, 9, 0]) > 0);
    assert.ok(compareVersions([14, 38, 9, 0], [14, 44, 1, 0]) < 0);
    assert.equal(compareVersions([1, 2, 3, 4], [1, 2, 3, 4]), 0);
});

test('bundleVcRuntime copies the NEWEST copy of each DLL, wherever it is', () => {
    const root = tmp();
    try {
        const older = path.join(root, 'python-internal');
        const newer = path.join(root, 'System32');
        writeAll(older, [14, 36, 1, 0], 'old');
        writeAll(newer, [14, 44, 2, 0], 'new');
        const target = path.join(root, 'llama');

        const report = bundleVcRuntime({ targetDir: target, searchDirs: [older, newer] });

        assert.equal(report.length, VC_RUNTIME_DLLS.length);
        for (const name of VC_RUNTIME_DLLS) {
            assert.deepEqual(peFileVersion(fs.readFileSync(path.join(target, name))), [14, 44, 2, 0]);
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('bundleVcRuntime matches names case-insensitively (System32 uses either case)', () => {
    const root = tmp();
    try {
        const sys = path.join(root, 'System32');
        fs.mkdirSync(sys, { recursive: true });
        for (const name of VC_RUNTIME_DLLS) fs.writeFileSync(path.join(sys, name.toUpperCase()), fakeDll([14, 40, 0, 0]));
        const target = path.join(root, 'llama');
        bundleVcRuntime({ targetDir: target, searchDirs: [sys] });
        for (const name of VC_RUNTIME_DLLS) assert.ok(fs.existsSync(path.join(target, name)));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('bundleVcRuntime fails loudly when a DLL exists nowhere', () => {
    const root = tmp();
    try {
        const partial = path.join(root, 'internal');
        fs.mkdirSync(partial, { recursive: true });
        fs.writeFileSync(path.join(partial, 'vcruntime140.dll'), fakeDll([14, 40, 0, 0]));
        assert.throws(
            () => bundleVcRuntime({ targetDir: path.join(root, 'llama'), searchDirs: [partial, path.join(root, 'nope')] }),
            /msvcp140\.dll, vcruntime140_1\.dll/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('ensureVcRuntime searches System32 and the frozen backend, then lands the DLLs in vendor/llama', () => {
    const project = tmp();
    const systemRoot = tmp();
    try {
        writeAll(path.join(project, 'backend-dist', 'app-backend', '_internal'), [14, 38, 0, 0]);
        writeAll(path.join(systemRoot, 'System32'), [14, 44, 0, 0]);

        const stillMissing = ensureVcRuntime(project, { systemRoot });

        assert.deepEqual(stillMissing, []);
        for (const name of VC_RUNTIME_DLLS) {
            const copied = fs.readFileSync(path.join(project, 'vendor', 'llama', name));
            assert.deepEqual(peFileVersion(copied), [14, 44, 0, 0]);
        }
    } finally {
        fs.rmSync(project, { recursive: true, force: true });
        fs.rmSync(systemRoot, { recursive: true, force: true });
    }
});
