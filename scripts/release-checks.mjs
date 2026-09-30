// Pure checks behind `npm run release` (scripts/release.mjs), kept apart
// from the network and child-process work so they're unit-testable
// (scripts/release.test.mjs).

// Just enough of electron-builder's update-manifest YAML (latest.yml /
// latest-mac.yml) for these checks: the top-level version, and each file's
// url and size under `files:`. Not a general YAML parser, and doesn't need
// to be -- electron-builder writes this format and nothing else.
export function parseManifest(text) {
    const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1] ?? null;
    const files = [];
    for (const line of text.split(/\r?\n/)) {
        const url = /^\s*-\s*url:\s*['"]?(.+?)['"]?\s*$/.exec(line);
        if (url) {
            files.push({ url: url[1], size: null });
            continue;
        }
        const size = /^\s+size:\s*(\d+)\s*$/.exec(line);
        if (size && files.length > 0 && files[files.length - 1].size === null) {
            files[files.length - 1].size = Number(size[1]);
        }
    }
    return { version, files, urls: files.map((f) => f.url) };
}

function parseSemver(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version ?? '');
    if (!match) return null;
    return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
}

// <0, 0, >0 like a sort comparator. A prerelease sorts before its release
// (1.1.0-beta.1 < 1.1.0); two prereleases compare as plain strings, which is
// enough to tell "same" from "different" -- all the checks below need.
export function compareVersions(a, b) {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb) return String(a).localeCompare(String(b));
    for (let i = 0; i < 3; i++) {
        if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] - pb.parts[i];
    }
    if (pa.pre === pb.pre) return 0;
    if (pa.pre === null) return 1;
    if (pb.pre === null) return -1;
    return pa.pre.localeCompare(pb.pre);
}

// Refuses to publish a version that's already out there (or older than
// what's out there). Re-publishing 1.0.0 over 1.0.0 is what kept existing
// users from ever getting an update: electron-updater only offers a
// version strictly greater than the installed one.
// Returns null when fine, else the reason.
export function versionProblem(localVersion, remoteVersion) {
    if (!remoteVersion) return null;
    const cmp = compareVersions(localVersion, remoteVersion);
    if (cmp === 0) {
        return `version ${localVersion} is already published. Bump "version" in package.json first -- ` +
            'installed apps only update to a strictly newer version.';
    }
    if (cmp < 0) {
        return `version ${localVersion} is older than the published ${remoteVersion}.`;
    }
    return null;
}

// Which Mac architecture an artifact is for, from electron-builder's
// default names: "<name>-<ver>-arm64-mac.zip" / "<name>-<ver>-arm64.dmg" for
// arm64, "-universal" for universal, and NO arch token at all for x64
// ("<name>-<ver>-mac.zip", "<name>-<ver>.dmg").
export function macArchOfUrl(url) {
    if (/[-_.]arm64[-_.]/.test(url)) return 'arm64';
    if (/[-_.]universal[-_.]/.test(url)) return 'universal';
    return 'x64';
}

// latest-mac.yml only ever lists the architecture of the machine that
// published it, so publishing an arm64 build over a manifest that also
// serves x64 silently drops the x64 users (and the website's download
// button with them). Returns null when fine, else the reason.
export function macArchProblem(remoteUrls, hostArch) {
    const otherArchs = [...new Set(remoteUrls.map(macArchOfUrl))].filter((arch) => arch !== hostArch);
    if (otherArchs.length === 0) return null;
    return `the published latest-mac.yml also lists ${otherArchs.join(', ')} files, and publishing from this ` +
        `${hostArch} machine would replace it with ${hostArch}-only entries -- users on ${otherArchs.join(', ')} ` +
        'would stop getting updates and the website download would lose their installer.';
}

// --check / --force / --force-arch, from argv or -- when a maintainer
// forgets the `--` in `npm run release -- --check` -- from npm's env: npm 7+
// turns `npm run release --check` into npm_config_check=true instead of
// passing the flag on, so "just checking" silently ran a full build and
// publish.
export function resolveFlags(argv, env) {
    const args = new Set(argv);
    const fromNpm = (name) => env[`npm_config_${name}`] === 'true' || env[`npm_config_${name}`] === '';
    return {
        checkOnly: args.has('--check') || fromNpm('check'),
        force: args.has('--force') || fromNpm('force'),
        forceArch: args.has('--force-arch') || fromNpm('force_arch'),
    };
}

// electron-builder publishes prerelease versions (1.1.0-beta.1) to
// beta*.yml / alpha*.yml, not latest*.yml, so none of the checks here (nor
// the website, nor installed apps on the default channel) would see them.
export function prereleaseProblem(version) {
    if (/^\d+\.\d+\.\d+-/.test(version ?? '')) {
        return `version ${version} is a prerelease. Prereleases publish to beta/alpha manifests that ` +
            'nothing here reads; release a plain X.Y.Z version instead.';
    }
    return null;
}

// A 200 that isn't really a manifest (an HTML error page, an empty body)
// parses to no version and no files -- which the version and architecture
// checks would both read as "nothing to worry about".
export function manifestProblem(manifest, url) {
    if (!manifest?.version || manifest.files.length === 0) {
        return `${url} answered, but not with a readable update manifest. Refusing to publish ` +
            "without knowing what's already out there.";
    }
    return null;
}
