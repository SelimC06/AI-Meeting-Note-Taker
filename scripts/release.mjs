// `npm run release` -- build and publish a release to the update bucket.
//
//   npm run release              check, build, publish
//   npm run release -- --check   only run the checks (no build, no upload)
//   npm run release -- --force   publish even if this version is already
//                                published (only to repair a broken upload)
//   npm run release -- --force-arch
//                                (macOS) publish even though it drops the
//                                other architecture from latest-mac.yml
//
// Everything that can refuse runs before the (long) build, so a release
// that was never going to be allowed doesn't cost ten minutes first.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUpdateFeedUrl, manifestNameForPlatform } from '../src/electron/updateFeed.js';
import { parseManifest, versionProblem, macArchProblem } from './release-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const force = args.has('--force');
const forceArch = args.has('--force-arch');

function fail(message) {
    console.error(`\nrelease: ${message}`);
    process.exit(1);
}

async function fetchManifest(url) {
    let res;
    try {
        res = await fetch(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    } catch (err) {
        fail(`couldn't reach ${url} (${err.message}). Refusing to publish without knowing what's already out there.`);
    }
    if (res.status === 404) return null; // nothing published for this platform yet
    if (!res.ok) fail(`${url} answered HTTP ${res.status}. Refusing to publish without knowing what's already out there.`);
    return parseManifest(await res.text());
}

function run(command, commandArgs) {
    console.log(`\n$ ${command} ${commandArgs.join(' ')}`);
    execFileSync(command, commandArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}

// After electron-builder reports success, check every file the published
// manifest points at really is there at full size. A large upload that
// died on a flaky network, with the manifest still uploaded, is otherwise
// only discovered by users whose update fails.
async function verifyPublished(feedUrl, manifestName, version) {
    const manifest = await fetchManifest(`${feedUrl}/${manifestName}`);
    if (manifest?.version !== version) {
        fail(`published ${manifestName} says ${manifest?.version ?? 'nothing'}, expected ${version}. Re-run with --force once the upload problem is fixed.`);
    }
    for (const { url, size } of manifest.files) {
        const res = await fetch(`${feedUrl}/${encodeURIComponent(url)}`, { method: 'HEAD', cache: 'no-store' });
        const length = res.headers.get('content-length');
        if (!res.ok || Number(length) !== size) {
            fail(`${url} is ${res.ok ? `${length} bytes, expected ${size}` : `missing (HTTP ${res.status})`}. ` +
                'The upload didn\'t finish -- re-run with --force to upload again.');
        }
        console.log(`verified ${url} (${size} bytes)`);
    }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const feedUrl = getUpdateFeedUrl();
const manifestName = manifestNameForPlatform(process.platform);

console.log(`release: ${pkg.build.productName} ${version} for ${process.platform}-${process.arch}`);
const remote = await fetchManifest(`${feedUrl}/${manifestName}`);
console.log(`published ${manifestName}: ${remote ? remote.version : 'none yet'}`);

const vProblem = versionProblem(version, remote?.version);
if (vProblem) {
    if (!force) fail(`${vProblem}\n(--force publishes anyway; only use it to repair a broken upload of this same version.)`);
    console.warn(`warning (--force): ${vProblem}`);
}

if (process.platform === 'darwin' && remote) {
    const aProblem = macArchProblem(remote.urls, process.arch);
    if (aProblem) {
        if (!forceArch) fail(`${aProblem}\n(--force-arch publishes anyway.)`);
        console.warn(`warning (--force-arch): ${aProblem}`);
    }
}

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    const message = 'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (the R2 write credentials) are not set.';
    if (!checkOnly) fail(message);
    console.warn(`note: ${message} A real release would stop here.`);
}

if (checkOnly) {
    console.log('\nrelease: checks passed (--check: nothing built or uploaded).');
    process.exit(0);
}

run('npm', ['run', 'build']);
run('npm', ['run', 'build:backend']);
run('npm', ['run', 'fetch:ffmpeg']);
run('npx', ['electron-builder', '--publish', 'always']);
await verifyPublished(feedUrl, manifestName, version);

console.log(`\nrelease: ${version} published and verified. Tag it:\n  git tag v${version} && git push origin v${version}`);
