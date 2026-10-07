import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import beforePack, { missingExtraResources } from './check-extra-resources.mjs';

function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extra-resources-'));
    fs.mkdirSync(path.join(dir, 'vendor', 'full'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vendor', 'full', 'bin'), 'x');
    fs.mkdirSync(path.join(dir, 'vendor', 'empty'), { recursive: true });
    return dir;
}

function context(projectDir, extraResources, platformExtraResources) {
    return {
        packager: {
            projectDir,
            config: { extraResources },
            platformSpecificBuildOptions: platformExtraResources ? { extraResources: platformExtraResources } : {},
        },
    };
}

test('missing and empty extraResources sources are reported; populated ones and glob strings are not', () => {
    const dir = project();
    try {
        const entries = [
            { from: 'vendor/full', to: 'full' },
            { from: 'vendor/empty', to: 'empty' },
            { from: 'vendor/absent', to: 'absent' },
            'some/glob/**',
        ];
        assert.deepEqual(missingExtraResources(dir, entries), ['vendor/empty', 'vendor/absent']);
        assert.deepEqual(missingExtraResources(dir, undefined), []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the beforePack hook fails the build on a missing source, including platform-specific ones', () => {
    const dir = project();
    try {
        assert.doesNotThrow(() => beforePack(context(dir, [{ from: 'vendor/full', to: 'full' }])));
        assert.throws(
            () => beforePack(context(dir, [{ from: 'vendor/full', to: 'full' }, { from: 'vendor/absent', to: 'x' }])),
            /vendor\/absent/,
        );
        assert.throws(
            () => beforePack(context(dir, [{ from: 'vendor/full', to: 'full' }], [{ from: 'vendor/empty', to: 'y' }])),
            /vendor\/empty/,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
