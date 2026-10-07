import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, compareVersions, versionProblem, macArchOfUrl, macArchProblem } from './release-checks.mjs';

const MAC_MANIFEST = `version: 1.0.0
files:
  - url: DeskRecap-1.0.0-arm64-mac.zip
    sha512: abc==
    size: 241332948
  - url: DeskRecap-1.0.0-arm64.dmg
    sha512: def==
    size: 240236075
path: DeskRecap-1.0.0-arm64-mac.zip
sha512: abc==
releaseDate: '2026-09-29T13:04:12.302Z'
`;

test('parseManifest reads the version and each file with its size', () => {
    const m = parseManifest(MAC_MANIFEST);
    assert.equal(m.version, '1.0.0');
    assert.deepEqual(m.files, [
        { url: 'DeskRecap-1.0.0-arm64-mac.zip', size: 241332948 },
        { url: 'DeskRecap-1.0.0-arm64.dmg', size: 240236075 },
    ]);
});

test('parseManifest handles the Windows manifest (a file name with spaces)', () => {
    const m = parseManifest("version: 1.2.0\nfiles:\n  - url: DeskRecap Setup 1.2.0.exe\n    sha512: x\n    size: 5\npath: DeskRecap Setup 1.2.0.exe\n");
    assert.equal(m.version, '1.2.0');
    assert.deepEqual(m.urls, ['DeskRecap Setup 1.2.0.exe']);
});

test('compareVersions orders by semver, with a prerelease before its release', () => {
    assert.ok(compareVersions('1.0.1', '1.0.0') > 0);
    assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
    assert.ok(compareVersions('1.1.0-beta.1', '1.1.0') < 0);
    assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
});

test('versionProblem refuses an already-published or older version, allows a newer one or a first release', () => {
    assert.match(versionProblem('1.0.0', '1.0.0'), /already published/);
    assert.match(versionProblem('0.9.0', '1.0.0'), /older/);
    assert.equal(versionProblem('1.0.1', '1.0.0'), null);
    assert.equal(versionProblem('1.0.0', null), null);
});

test('macArchOfUrl follows electron-builder default artifact names (x64 has no arch token)', () => {
    assert.equal(macArchOfUrl('DeskRecap-1.0.0-arm64-mac.zip'), 'arm64');
    assert.equal(macArchOfUrl('DeskRecap-1.0.0-arm64.dmg'), 'arm64');
    assert.equal(macArchOfUrl('DeskRecap-1.0.0-mac.zip'), 'x64');
    assert.equal(macArchOfUrl('DeskRecap-1.0.0.dmg'), 'x64');
    assert.equal(macArchOfUrl('DeskRecap-1.0.0-universal-mac.zip'), 'universal');
});

test('macArchProblem refuses to drop another architecture from latest-mac.yml', () => {
    const armOnly = parseManifest(MAC_MANIFEST).urls;
    assert.equal(macArchProblem(armOnly, 'arm64'), null);
    assert.match(macArchProblem(armOnly, 'x64'), /arm64/);
    assert.match(macArchProblem([...armOnly, 'DeskRecap-1.0.0-mac.zip'], 'arm64'), /x64/);
    assert.equal(macArchProblem([], 'arm64'), null);
});

test('resolveFlags honours both `-- --check` and npm\'s npm_config_check (a forgotten `--`)', async () => {
    const { resolveFlags } = await import('./release-checks.mjs');
    assert.deepEqual(resolveFlags(['--check'], {}), { checkOnly: true, force: false, forceArch: false });
    assert.deepEqual(resolveFlags([], { npm_config_check: 'true' }), { checkOnly: true, force: false, forceArch: false });
    assert.deepEqual(
        resolveFlags([], { npm_config_force: 'true', npm_config_force_arch: 'true' }),
        { checkOnly: false, force: true, forceArch: true }
    );
    assert.deepEqual(resolveFlags([], {}), { checkOnly: false, force: false, forceArch: false });
});

test('an explicitly false npm flag (exported as an empty value) never forces a release', async () => {
    const { resolveFlags } = await import('./release-checks.mjs');
    // `npm run release --no-force --no-force-arch`
    assert.deepEqual(
        resolveFlags([], { npm_config_force: '', npm_config_force_arch: '' }),
        { checkOnly: false, force: false, forceArch: false },
    );
    // `--no-check` errs on the side of not publishing.
    assert.equal(resolveFlags([], { npm_config_check: '' }).checkOnly, true);
});

test('prerelease versions are refused', async () => {
    const { prereleaseProblem } = await import('./release-checks.mjs');
    assert.match(prereleaseProblem('1.1.0-beta.1'), /prerelease/);
    assert.equal(prereleaseProblem('1.1.0'), null);
});

test('an unreadable manifest is a problem, not "nothing published"', async () => {
    const { manifestProblem } = await import('./release-checks.mjs');
    assert.match(manifestProblem(parseManifest('<html>Not found</html>'), 'u'), /readable/);
    assert.match(manifestProblem(parseManifest(''), 'u'), /readable/);
    assert.match(manifestProblem(parseManifest('version: 1.0.0\n'), 'u'), /readable/); // no files
    assert.equal(manifestProblem(parseManifest(MAC_MANIFEST), 'u'), null);
});
