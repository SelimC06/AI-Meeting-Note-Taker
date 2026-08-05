import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const vendorDir = path.join(projectRoot, 'vendor', 'ffmpeg');
const ffmpegExe = path.join(vendorDir, 'ffmpeg.exe');
const ffprobeExe = path.join(vendorDir, 'ffprobe.exe');

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

if (fs.existsSync(ffmpegExe) && fs.existsSync(ffprobeExe)) {
    console.log(`ffmpeg/ffprobe already present at ${vendorDir}, skipping download.`);
    process.exit(0);
}

fs.mkdirSync(vendorDir, { recursive: true });

const tmpDir = fs.mkdtempSync(path.join(projectRoot, 'vendor', 'tmp-ffmpeg-'));
const zipPath = path.join(tmpDir, 'ffmpeg.zip');

console.log(`Downloading ffmpeg from ${FFMPEG_ZIP_URL} ...`);
const response = await fetch(FFMPEG_ZIP_URL);
if (!response.ok) {
    console.error(`Download failed: HTTP ${response.status}`);
    process.exit(1);
}
const buffer = Buffer.from(await response.arrayBuffer());

console.log('Verifying checksum...');
const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
if (actualHash !== FFMPEG_ZIP_SHA256) {
    console.error(
        `Checksum mismatch for downloaded ffmpeg archive.\n` +
        `  expected: ${FFMPEG_ZIP_SHA256}\n` +
        `  actual:   ${actualHash}\n` +
        `Refusing to extract a file that does not match the pinned checksum.`,
    );
    process.exit(1);
}
console.log('Checksum OK.');

fs.writeFileSync(zipPath, buffer);

console.log('Extracting archive...');
const extractDir = path.join(tmpDir, 'extracted');
const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
], { stdio: 'inherit' });
if (result.status !== 0) {
    console.error('Extraction failed.');
    process.exit(result.status ?? 1);
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

const foundFfmpeg = findFile(extractDir, 'ffmpeg.exe');
const foundFfprobe = findFile(extractDir, 'ffprobe.exe');
if (!foundFfmpeg || !foundFfprobe) {
    console.error('Could not locate ffmpeg.exe/ffprobe.exe inside the downloaded archive.');
    process.exit(1);
}

fs.copyFileSync(foundFfmpeg, ffmpegExe);
fs.copyFileSync(foundFfprobe, ffprobeExe);
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`ffmpeg/ffprobe ready at ${vendorDir}`);
