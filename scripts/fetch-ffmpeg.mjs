import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const vendorDir = path.join(projectRoot, 'vendor', 'ffmpeg');
const isWin = process.platform === 'win32';
const exeSuffix = isWin ? '.exe' : '';
const ffmpegExe = path.join(vendorDir, `ffmpeg${exeSuffix}`);
const ffprobeExe = path.join(vendorDir, `ffprobe${exeSuffix}`);

// Pinned to a specific, versioned gyan.dev build rather than the rolling
// "ffmpeg-release-essentials.zip" link, which silently tracks whatever the latest
// release is (it already drifted to ffmpeg 9.0 mid-project, which changed CLI flag
// behavior -vsync/-fps_mode). Pinned to 9.0 to match the ffmpeg build already
// vendored in this repo and already verified in Task 8.
//
// Served from gyan.dev's official GitHub mirror (GyanD/codexffmpeg), not
// gyan.dev's own packages/ URL: gyan.dev only keeps the latest release there,
// and .../packages/ffmpeg-9.0-essentials_build.zip started returning 404 as soon
// as 9.0.2 came out -- breaking every Windows build. A GitHub release asset is a
// durable, versioned copy (assets stay on their release when newer releases are
// published), and it's byte-for-byte the same file: its SHA-256 is exactly
// FFMPEG_ZIP_SHA256 below. GitHub answers with a redirect to its CDN, which
// fetch() follows by default (downloadAndVerify doesn't change `redirect`).
const FFMPEG_ZIP_URL = 'https://github.com/GyanD/codexffmpeg/releases/download/9.0/ffmpeg-9.0-essentials_build.zip';

// SHA-256 of the file at FFMPEG_ZIP_URL above, computed on 2026-08-05 by downloading
// the URL and running `sha256sum` (cross-checked with node:crypto); re-verified
// against the GitHub mirror URL on 2026-09-30 (identical). If the URL is
// ever repinned to a new ffmpeg version, download the new zip, recompute its hash
// the same way, and update this constant to match.
const FFMPEG_ZIP_SHA256 = 'e6b54767a6065919048f1a098eb27211ca4e12b4348a05d88777a5855d0b6e71';

// macOS sources, per architecture. No single upstream ships both, so each arch gets
// its own pinned pair -- and the arch MUST match the machine doing the build: the
// PyInstaller-frozen backend (npm run build:backend) is host-native and can't
// cross-compile, so a mac package is only ever coherent when ffmpeg, the backend, and
// the Electron shell are all the same arch. Fetching arm64 binaries on an Intel Mac
// (which is what this script did unconditionally before) produced a package whose
// ffmpeg simply could not execute.
//
// arm64/Apple Silicon: evermeet.cx explicitly does not build for Apple Silicon
// (Intel-only, run under Rosetta), so arm64 pins to osxexperts.net's native arm64
// static builds, which ship ffmpeg and ffprobe as two SEPARATE per-tool zips (no
// combined "essentials" bundle like gyan.dev), hence the independent URL/hash pairs
// rather than one FFMPEG_ZIP_URL-shaped constant. Pinned to their "9.0 (Apple
// Silicon)" build (binary filenames `ffmpeg9arm.zip` / `ffprobe9arm.zip` encode the
// major.minor version, not a patch/date, so re-verify the hash on every repin even
// if the URL text doesn't change). Downloaded both zips and computed SHA-256 with
// `sha256sum` (cross-checked with node:crypto) on 2026-08-12; note the checksums
// osxexperts.net displays on-page (591260c9...0a95e for ffmpeg,
// e11c17e8...469106 for ffprobe) did NOT match the bytes actually served at these
// URLs on that date — the constants below are what was independently recomputed
// from the real downloaded files, per this task's verification requirement, not
// what the page claims.
//
// x64/Intel: evermeet.cx is the closest macOS analogue to gyan.dev and is the source
// osxexperts itself points at for Intel. Pinned to its versioned 9.0.1 URLs (NOT the
// rolling `getrelease` endpoint, same reasoning as FFMPEG_ZIP_URL above) to stay on
// the same ffmpeg 9.x line as the other two platforms. Both zips were downloaded and
// their SHA-256 computed with `shasum -a 256`, cross-checked with node:crypto, on
// 2026-08-12; the extracted binaries were confirmed `Mach-O 64-bit executable x86_64`
// and each reported `9.0.1-tessus` from `-version`.
const MAC_SOURCES = {
    arm64: {
        ffmpeg: {
            url: 'https://www.osxexperts.net/ffmpeg9arm.zip',
            sha256: 'd0c06c5c68ce48af3143b262f7a9118a7c9f67de1e237fcc24ffb14df9c67af9',
        },
        ffprobe: {
            url: 'https://www.osxexperts.net/ffprobe9arm.zip',
            sha256: '0c94fbdd8917022f28115eca512196cf4648732bc9e5db9ec8896c7e519d02aa',
        },
    },
    x64: {
        ffmpeg: {
            url: 'https://evermeet.cx/ffmpeg/ffmpeg-9.0.1.zip',
            sha256: '8a8c9e549983409fe6604b9aa665648b7a5def9407fe814c39c8b2ea7f64a48f',
        },
        ffprobe: {
            url: 'https://evermeet.cx/ffmpeg/ffprobe-9.0.1.zip',
            sha256: 'd13f35db03456b7f65b7edb6437c86e23810fbfe91795e571f5b77211343b4f1',
        },
    },
};

// Records which arch the vendored binaries were fetched for AND the SHA-256 of the
// pinned archive(s) they came from ("<arch> <sha256> [<sha256>]"), so a vendor/
// directory carried over from a different machine, or fetched before a repin, is
// re-fetched instead of silently packaged. (Checked alongside the binaries'
// existence below.) An older arch-only stamp never matches, so such a directory
// is re-fetched once.
const archStampFile = path.join(vendorDir, '.arch');

const wantedArch = isWin ? 'x64' : process.arch;
const pinnedSha256 = isWin
    ? FFMPEG_ZIP_SHA256
    : `${MAC_SOURCES[wantedArch]?.ffmpeg.sha256} ${MAC_SOURCES[wantedArch]?.ffprobe.sha256}`;
const wantedStamp = `${wantedArch} ${pinnedSha256}`;
const stamp = fs.existsSync(archStampFile) ? fs.readFileSync(archStampFile, 'utf8').trim() : null;
const stampedArch = stamp ? stamp.split(/\s+/)[0] : null;

if (fs.existsSync(ffmpegExe) && fs.existsSync(ffprobeExe) && stamp === wantedStamp) {
    console.log(`ffmpeg/ffprobe (${wantedArch}) already present at ${vendorDir}, skipping download.`);
    process.exit(0);
}
if (stampedArch && stampedArch !== wantedArch) {
    console.log(`Vendored ffmpeg/ffprobe are ${stampedArch}, but this machine needs ${wantedArch} — re-fetching.`);
} else if (stamp && stamp !== wantedStamp) {
    console.log('Vendored ffmpeg/ffprobe are not the pinned build — re-fetching.');
}

fs.mkdirSync(vendorDir, { recursive: true });

const tmpDir = fs.mkdtempSync(path.join(projectRoot, 'vendor', 'tmp-ffmpeg-'));

async function downloadAndVerify(url, expectedSha256, destFilename) {
    console.log(`Downloading ${url} ...`);
    const response = await fetch(url);
    if (!response.ok) {
        console.error(`Download failed: HTTP ${response.status}`);
        process.exit(1);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    console.log('Verifying checksum...');
    const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actualHash !== expectedSha256) {
        console.error(
            `Checksum mismatch for downloaded archive at ${url}.\n` +
            `  expected: ${expectedSha256}\n` +
            `  actual:   ${actualHash}\n` +
            `Refusing to extract a file that does not match the pinned checksum.`,
        );
        process.exit(1);
    }
    console.log('Checksum OK.');

    const destPath = path.join(tmpDir, destFilename);
    fs.writeFileSync(destPath, buffer);
    return destPath;
}

function extractZip(zipPath, extractDir) {
    console.log(`Extracting ${zipPath} ...`);
    fs.mkdirSync(extractDir, { recursive: true });
    const result = isWin
        ? spawnSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
        ], { stdio: 'inherit' })
        : spawnSync('unzip', ['-o', zipPath, '-d', extractDir], { stdio: 'inherit' });
    if (result.status !== 0) {
        console.error('Extraction failed.');
        process.exit(result.status ?? 1);
    }
}

const extractDir = path.join(tmpDir, 'extracted');

if (isWin) {
    const zipPath = await downloadAndVerify(FFMPEG_ZIP_URL, FFMPEG_ZIP_SHA256, 'ffmpeg.zip');
    extractZip(zipPath, extractDir);
} else {
    const macSource = MAC_SOURCES[wantedArch];
    if (!macSource) {
        console.error(
            `No pinned macOS ffmpeg build for architecture "${wantedArch}" `
            + `(have: ${Object.keys(MAC_SOURCES).join(', ')}).`,
        );
        process.exit(1);
    }
    const ffmpegZipPath = await downloadAndVerify(macSource.ffmpeg.url, macSource.ffmpeg.sha256, 'ffmpeg.zip');
    const ffprobeZipPath = await downloadAndVerify(macSource.ffprobe.url, macSource.ffprobe.sha256, 'ffprobe.zip');
    extractZip(ffmpegZipPath, extractDir);
    extractZip(ffprobeZipPath, extractDir);
}

function findFile(dir, filename) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFile(full, filename);
            if (found) return found;
        } else if (entry.name.toLowerCase() === filename.toLowerCase()) {
            return full;
        }
    }
    return null;
}

const foundFfmpeg = findFile(extractDir, `ffmpeg${exeSuffix}`);
const foundFfprobe = findFile(extractDir, `ffprobe${exeSuffix}`);
if (!foundFfmpeg || !foundFfprobe) {
    console.error(`Could not locate ffmpeg${exeSuffix}/ffprobe${exeSuffix} inside the downloaded archive.`);
    process.exit(1);
}

fs.copyFileSync(foundFfmpeg, ffmpegExe);
fs.copyFileSync(foundFfprobe, ffprobeExe);
if (!isWin) {
    // unzip on macOS generally preserves the executable bit from the archive, but
    // set it explicitly so a repin to a zip that doesn't store it can't silently
    // produce a non-executable binary.
    fs.chmodSync(ffmpegExe, 0o755);
    fs.chmodSync(ffprobeExe, 0o755);
}
fs.writeFileSync(archStampFile, `${wantedStamp}\n`);
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`ffmpeg/ffprobe (${wantedArch}) ready at ${vendorDir}`);
