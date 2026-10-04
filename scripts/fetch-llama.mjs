import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

// Vendors the llama.cpp `llama-server` binary (plus its shared libraries)
// into vendor/llama, following fetch-ffmpeg.mjs exactly: pinned versioned
// GitHub release assets (never a rolling "latest"), SHA-256 verified before
// extraction, and an .arch stamp so a vendor/ dir carried over from a
// different machine is re-fetched instead of packaged into a build it
// can't run on. The backend spawns this binary as the built-in AI provider
// (backend/app/builtin_llm.py); electron-builder ships vendor/llama via
// extraResources, and main.js points the backend at it with
// LLAMA_SERVER_BIN.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const vendorDir = path.join(projectRoot, 'vendor', 'llama');
const isWin = process.platform === 'win32';
const exeSuffix = isWin ? '.exe' : '';
const serverExe = path.join(vendorDir, `llama-server${exeSuffix}`);

// Pinned to llama.cpp release b11382 (ggml-org/llama.cpp). Release assets
// are durable, versioned copies -- they stay on their release when newer
// builds are published. Each SHA-256 below was computed on 2026-10-03 by
// downloading the asset and running `shasum -a 256` on the exact bytes
// served; if the pin is ever moved to a newer build, download the new
// assets, recompute their hashes the same way, and update URL + hash
// together.
//
// Windows uses the CPU build (broadest compatibility -- no GPU driver or
// runtime DLL requirements; llama-server just logs that no GPU backend is
// available and runs on CPU). macOS builds ship Metal support in the
// default arm64/x64 archives.
const LLAMA_TAG = 'b11382';
const SOURCES = {
    win32: {
        x64: {
            url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`,
            sha256: '40d55282382909be50d27a3e182885860c28ff148e4d952beca7aaad91504051',
            archive: 'zip',
        },
    },
    darwin: {
        arm64: {
            url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/llama-${LLAMA_TAG}-bin-macos-arm64.tar.gz`,
            sha256: 'c2540b6515cf508c270815b494ff3f228818165fe7dcdac73f643e4f10bde2e6',
            archive: 'tar.gz',
        },
        x64: {
            url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/llama-${LLAMA_TAG}-bin-macos-x64.tar.gz`,
            sha256: '37355fefe4fd208172746872e173f10e19d945ac35da01a209d9518e6ba39c13',
            archive: 'tar.gz',
        },
    },
};

const archStampFile = path.join(vendorDir, '.arch');
// Same rule as fetch-ffmpeg.mjs: Windows packages are only built x64, and a
// mac package is only coherent when every native piece matches the build
// machine's arch (the PyInstaller backend can't cross-compile).
const wantedArch = isWin ? 'x64' : process.arch;
const stampedArch = fs.existsSync(archStampFile) ? fs.readFileSync(archStampFile, 'utf8').trim() : null;

if (fs.existsSync(serverExe) && stampedArch === wantedArch) {
    console.log(`llama-server (${wantedArch}) already present at ${vendorDir}, skipping download.`);
    process.exit(0);
}
if (stampedArch && stampedArch !== wantedArch) {
    console.log(`Vendored llama-server is ${stampedArch}, but this machine needs ${wantedArch} — re-fetching.`);
}

const source = SOURCES[process.platform]?.[wantedArch];
if (!source) {
    console.error(
        `No pinned llama.cpp build for ${process.platform}/${wantedArch} `
        + `(have: ${Object.entries(SOURCES).map(([p, a]) => `${p}:${Object.keys(a).join('/')}`).join(', ')}).`,
    );
    process.exit(1);
}

fs.rmSync(vendorDir, { recursive: true, force: true });
fs.mkdirSync(vendorDir, { recursive: true });

const tmpDir = fs.mkdtempSync(path.join(projectRoot, 'vendor', 'tmp-llama-'));

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

function extract(archivePath, kind, extractDir) {
    console.log(`Extracting ${archivePath} ...`);
    fs.mkdirSync(extractDir, { recursive: true });
    const result = kind === 'zip'
        ? (isWin
            ? spawnSync('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command',
                `Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force`,
            ], { stdio: 'inherit' })
            : spawnSync('unzip', ['-o', archivePath, '-d', extractDir], { stdio: 'inherit' }))
        : spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'inherit' });
    if (result.status !== 0) {
        console.error('Extraction failed.');
        process.exit(result.status ?? 1);
    }
}

const archiveName = source.archive === 'zip' ? 'llama.zip' : 'llama.tar.gz';
const archivePath = await downloadAndVerify(source.url, source.sha256, archiveName);
const extractDir = path.join(tmpDir, 'extracted');
extract(archivePath, source.archive, extractDir);

// Keep only what llama-server needs at runtime: the binary itself, every
// shared library beside it (libggml*/libllama*/ggml-*.dll etc. -- resolved
// via @rpath on macOS and loader-directory lookup on Windows), and the
// LICENSE. The archives also carry a dozen other llama-* tools (cli,
// perplexity, bench...) that would roughly triple the shipped size for
// nothing.
function collectFiles(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectFiles(full, out);
        } else {
            out.push(full);
        }
    }
    return out;
}

const wanted = (name) => {
    const lower = name.toLowerCase();
    return (
        lower === `llama-server${exeSuffix}` ||
        lower === 'license' ||
        lower.endsWith('.dylib') ||
        lower.endsWith('.dll')
    );
};

let copied = 0;
for (const file of collectFiles(extractDir, [])) {
    const name = path.basename(file);
    if (!wanted(name)) continue;
    const dest = path.join(vendorDir, name);
    fs.copyFileSync(file, dest);
    copied += 1;
}

if (!fs.existsSync(serverExe)) {
    console.error(`Could not locate llama-server${exeSuffix} inside the downloaded archive.`);
    process.exit(1);
}
if (!isWin) {
    // tar generally preserves the executable bit, but set it explicitly so
    // a repin to an archive that doesn't store it can't silently produce a
    // non-executable binary (same guard as fetch-ffmpeg.mjs).
    fs.chmodSync(serverExe, 0o755);
}

fs.writeFileSync(archStampFile, `${wantedArch}\n`);
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`llama-server (${wantedArch}, ${copied} files) ready at ${vendorDir}`);
