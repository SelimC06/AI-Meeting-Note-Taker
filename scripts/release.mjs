// `npm run release` -- build and publish a release to the update bucket.
//
//   npm run release              check, build, upload, verify
//   npm run release -- --check   only run the checks (no build, no upload)
//   npm run release -- --force-arch
//                                (macOS) publish even though it drops the
//                                other architecture from latest-mac.yml
//
// (`npm run release --check`, without the `--`, works too -- see
// resolveFlags.)
//
// Everything that can refuse runs before the (long) build, so a release
// that was never going to be allowed doesn't cost ten minutes first. The
// build itself never uploads (`electron-builder --publish never`); the files
// are then uploaded by scripts/upload-r2.mjs in 10 MB retried parts, with
// the manifest LAST, only after every installer and blockmap made it.
//
// Published versions are immutable (docs/adr/0001): once a version's
// manifest is live, its installers are never overwritten. A rebuild never
// reproduces the same bytes, so re-uploading under the same names leaves the
// CDN serving the old installer against the new manifest's sha512, and every
// auto-update fails its checksum. A failed upload is safe to re-run (the
// manifest goes last, so the version never went live); anything wrong after
// it went live ships as the next patch version.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FEED_URL, manifestNameForPlatform } from '../src/electron/updateFeed.js';
import {
    parseManifest,
    versionProblem,
    macArchProblem,
    resolveFlags,
    prereleaseProblem,
    manifestProblem,
} from './release-checks.mjs';
import { createR2Client, r2ConfigFromPackageJson, uploadAll } from './upload-r2.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');
const { checkOnly, force, forceArch } = resolveFlags(process.argv.slice(2), process.env);
// After the manifest is live (verification failed): the version is final.
const REPAIR_HINT = 'This version is now live and final (published installers are immutable, docs/adr/0001). ' +
    'Fix the problem, bump the patch version in package.json, and release again.';
// Before the manifest went live (an upload failed): nothing was published.
const RETRY_HINT = 'Users still get the previous version. Fix the problem and run `npm run release` again.';
const FETCH_TIMEOUT_MS = 30000;

function fail(message) {
    console.error(`\nrelease: ${message}`);
    process.exit(1);
}

// Refused before anything touches the network: there is nothing to check.
if (force) {
    fail(
        '--force was removed: a published version is final, because re-uploading an installer under the same ' +
        'name leaves the CDN serving the old one against the new manifest (docs/adr/0001). Bump the patch ' +
        'version in package.json and release that instead.',
    );
}

async function fetchManifest(url, { allowMissing = true } = {}) {
    let res;
    try {
        res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' });
    } catch (err) {
        fail(`couldn't reach ${url} (${err.message}). Refusing to publish without knowing what's already out there.`);
    }
    if (res.status === 404 && allowMissing) return null; // nothing published for this platform yet
    if (!res.ok) fail(`${url} answered HTTP ${res.status}. Refusing to publish without knowing what's already out there.`);
    const manifest = parseManifest(await res.text());
    const problem = manifestProblem(manifest, url);
    if (problem) fail(problem);
    return manifest;
}

// The R2 write keys are only for the upload this script does itself
// (createR2Client below; electron-builder runs with --publish never), so
// they're kept out of every child's environment, where any build-time
// dependency (pip, PyInstaller hooks, vite plugins, electron-builder's
// downloads) could read them. Case-insensitive: Windows env names are, and a
// copy of process.env keeps whatever casing a variable was created with.
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^AWS_/i.test(name)));

function run(command, commandArgs) {
    console.log(`\n$ ${command} ${commandArgs.join(' ')}`);
    try {
        execFileSync(command, commandArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: childEnv });
    } catch (err) {
        fail(`\`${command} ${commandArgs.join(' ')}\` failed (${err.status != null ? `exit ${err.status}` : err.message}). Nothing was uploaded.`);
    }
}

// The files electron-builder produced for this version, read from the local
// manifest it wrote next to them: every installer it lists plus its
// .blockmap (used for differential updates), then the manifest itself.
function releaseFiles(manifestName, version) {
    const manifestPath = path.join(releaseDir, manifestName);
    if (!fs.existsSync(manifestPath)) fail(`the build didn't produce ${manifestPath}.`);
    const local = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
    if (local.version !== version) {
        fail(`release/${manifestName} is for ${local.version}, not ${version} -- a stale build? Nothing was uploaded.`);
    }
    const files = [];
    for (const { url } of local.files) {
        const file = path.join(releaseDir, url);
        if (!fs.existsSync(file)) fail(`release/${manifestName} lists ${url}, but it isn't in release/. Nothing was uploaded.`);
        files.push(file);
        if (fs.existsSync(`${file}.blockmap`)) files.push(`${file}.blockmap`);
    }
    files.push(manifestPath);
    return files;
}

// After uploading, check every file the published manifest points at really
// is there at full size -- a truncated upload is otherwise only discovered by
// users whose update or download fails.
async function verifyPublished(feedUrl, manifestName, version) {
    const manifest = await fetchManifest(`${feedUrl}/${manifestName}`, { allowMissing: false });
    if (manifest.version !== version) {
        fail(`published ${manifestName} says ${manifest.version}, expected ${version}. ${REPAIR_HINT}`);
    }
    for (const { url, size } of manifest.files) {
        let res;
        try {
            res = await fetch(`${feedUrl}/${encodeURIComponent(url)}`, {
                method: 'HEAD',
                cache: 'no-store',
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
        } catch (err) {
            fail(`couldn't check ${url} (${err.message}). ${REPAIR_HINT}`);
        }
        const length = res.headers.get('content-length');
        if (!res.ok || Number(length) !== size) {
            fail(`${url} is ${res.ok ? `${length} bytes, expected ${size}` : `missing (HTTP ${res.status})`}. ${REPAIR_HINT}`);
        }
        console.log(`verified ${url} (${size} bytes)`);
    }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const manifestName = manifestNameForPlatform(process.platform);

// The upload always goes to the production bucket (build.publish), so the
// checks must read production too -- UPDATE_FEED_URL points the APP at a
// different feed, and honouring it here compared against one place while
// uploading to another.
if (process.env.UPDATE_FEED_URL) {
    fail('UPDATE_FEED_URL is set. It only redirects the app; releases always go to the production bucket. Unset it first.');
}
const feedUrl = DEFAULT_FEED_URL;

console.log(`release: ${pkg.build.productName} ${version} for ${process.platform}-${process.arch}${checkOnly ? ' (checks only)' : ''}`);

const preProblem = prereleaseProblem(version);
if (preProblem) fail(preProblem);

const remote = await fetchManifest(`${feedUrl}/${manifestName}`);
console.log(`published ${manifestName}: ${remote ? remote.version : 'none yet'}`);

const vProblem = versionProblem(version, remote?.version);
if (vProblem) fail(vProblem);

if (process.platform === 'darwin' && remote) {
    const aProblem = macArchProblem(remote.urls, process.arch);
    if (aProblem) {
        if (!forceArch) fail(`${aProblem}\n(--force-arch publishes anyway.)`);
        console.warn(`warning (--force-arch): ${aProblem}`);
    }
}

const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
if (!accessKeyId || !secretAccessKey) {
    const message = 'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (the R2 write credentials) are not set.';
    if (!checkOnly) fail(message);
    console.warn(`note: ${message} A real release would stop here.`);
}

if (checkOnly) {
    console.log('\nrelease: checks passed (--check: nothing built or uploaded).');
    process.exit(0);
}

// The vendored binaries first: fetching them is what can fail on the network
// or a pinned checksum, and nothing in build/build:backend reads vendor/.
// fetch:vendor (package.json, shared with `dist` and CI) runs every fetcher
// behind a build.extraResources directory; each downloads unless vendor/
// already holds its pinned files (for this machine's arch, where that
// matters). If a directory is still missing or empty, electron-builder's
// beforePack hook (scripts/check-extra-resources.mjs) refuses to package.
run('npm', ['run', 'fetch:vendor']);
run('npm', ['run', 'build']);
run('npm', ['run', 'build:backend']);
run('npx', ['electron-builder', '--publish', 'never']);

const files = releaseFiles(manifestName, version);

// The version check above ran before the build. If this version was
// published meanwhile (another CI run, or a release from another machine),
// uploading would overwrite that build's installer under the same name with
// different bytes, and latest.yml's sha512 would no longer match it.
{
    const latest = await fetchManifest(`${feedUrl}/${manifestName}`);
    const lateProblem = versionProblem(version, latest?.version);
    if (lateProblem) fail(`${lateProblem} (It was published while this build ran.) Nothing was uploaded.`);
}
console.log(`\nuploading ${files.length} files (${manifestName} last):`);
const client = createR2Client({ ...r2ConfigFromPackageJson(pkg), accessKeyId, secretAccessKey });
try {
    await uploadAll(client, files);
} catch (err) {
    fail(`upload failed: ${err.message}. ${manifestName} was NOT updated. ${RETRY_HINT}`);
}

await verifyPublished(feedUrl, manifestName, version);


// In CI the commit that was built is GITHUB_SHA (what actions/checkout
// checked out), which needn't be the maintainer's local HEAD -- tag that one.
const builtCommit = process.env.GITHUB_ACTIONS === 'true' ? process.env.GITHUB_SHA : null;
const tagCommand = builtCommit
    ? `git fetch origin && git tag v${version} ${builtCommit} && git push origin v${version}`
    : `git tag v${version} && git push origin v${version}`;
console.log(`\nrelease: ${version} published and verified. Tag it:\n  ${tagCommand}`);
