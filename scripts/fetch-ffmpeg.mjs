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

// Pinned to a specific, versioned gyan.dev "packages" URL rather than the rolling
// "ffmpeg-release-essentials.zip" link, which silently tracks whatever the latest
// release is (it already drifted to ffmpeg 9.0 mid-project, which changed CLI flag
// behavior -vsync/-fps_mode). Pinned to 9.0 to match the ffmpeg build already
// vendored in this repo and already verified in Task 8.
const FFMPEG_ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0-essentials_build.zip';

// SHA-256 of the file at FFMPEG_ZIP_URL above, computed on 2026-08-05 by downloading
// the URL and running `sha256sum` (cross-checked with node:crypto). If the URL is
// ever repinned to a new ffmpeg version, download the new zip, recompute its hash
// the same way, and update this constant to match.
const FFMPEG_ZIP_SHA256 = 'e6b54767a6065919048f1a098eb27211ca4e12b4348a05d88777a5855d0b6e71';

// macOS (arm64/Apple Silicon) source. evermeet.cx — the closest macOS analogue to
// gyan.dev — explicitly does not build for Apple Silicon (Intel-only, run under
// Rosetta), so this pins to osxexperts.net's native arm64 static builds instead,
// which ship ffmpeg and ffprobe as two SEPARATE per-tool zips (no combined
// "essentials" bundle like gyan.dev), hence the two independent URL/hash pairs
// below rather than one FFMPEG_ZIP_URL-shaped constant. Pinned to their "9.0 (Apple
// Silicon)" build (binary filenames `ffmpeg9arm.zip` / `ffprobe9arm.zip` encode the
// major.minor version, not a patch/date, so re-verify the hash on every repin even
// if the URL text doesn't change). Downloaded both zips and computed SHA-256 with
// `sha256sum` (cross-checked with node:crypto) on 2026-08-12; note the checksums
// osxexperts.net displays on-page (591260c9...0a95e for ffmpeg,
// e11c17e8...469106 for ffprobe) did NOT match the bytes actually served at these
// URLs on that date — the constants below are what was independently recomputed
// from the real downloaded files, per this task's verification requirement, not
// what the page claims.
const FFMPEG_MAC_ZIP_URL = 'https://www.osxexperts.net/ffmpeg9arm.zip';
const FFMPEG_MAC_ZIP_SHA256 = 'd0c06c5c68ce48af3143b262f7a9118a7c9f67de1e237fcc24ffb14df9c67af9';
const FFPROBE_MAC_ZIP_URL = 'https://www.osxexperts.net/ffprobe9arm.zip';
const FFPROBE_MAC_ZIP_SHA256 = '0c94fbdd8917022f28115eca512196cf4648732bc9e5db9ec8896c7e519d02aa';

if (fs.existsSync(ffmpegExe) && fs.existsSync(ffprobeExe)) {
    console.log(`ffmpeg/ffprobe already present at ${vendorDir}, skipping download.`);
    process.exit(0);
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
    const ffmpegZipPath = await downloadAndVerify(FFMPEG_MAC_ZIP_URL, FFMPEG_MAC_ZIP_SHA256, 'ffmpeg.zip');
    const ffprobeZipPath = await downloadAndVerify(FFPROBE_MAC_ZIP_URL, FFPROBE_MAC_ZIP_SHA256, 'ffprobe.zip');
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
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`ffmpeg/ffprobe ready at ${vendorDir}`);
