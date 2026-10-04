import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

// Vendors the pinned speaker-embedding ONNX model into vendor/speaker,
// following fetch-ffmpeg.mjs / fetch-llama.mjs: a pinned, versioned GitHub
// release asset, SHA-256 verified against bytes actually downloaded. The
// backend runs it through sherpa-onnx (backend/app/speaker_id.py) to
// cluster meeting speakers and match persistent voice profiles; Electron
// points the backend at it with SPEAKER_MODEL_PATH, and electron-builder
// ships vendor/speaker via extraResources.
//
// ONNX files are architecture-independent, so unlike ffmpeg/llama there is
// no per-arch source table and no .arch stamp.
//
// Model: CAM++ speaker-verification, 3D-Speaker zh/en "advanced" build,
// published by the sherpa-onnx project (release tag spelled
// "speaker-recongition-models" upstream -- their typo, kept verbatim).
// SHA-256 computed on 2026-10-03 from the downloaded bytes with
// `shasum -a 256`. Measured with this exact file: same-speaker cosine
// ~0.9+, different-speaker ~0.2 (thresholds in speaker_id.py assume this
// model -- re-measure if the pin ever changes).
const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx';
const MODEL_SHA256 = 'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const vendorDir = path.join(projectRoot, 'vendor', 'speaker');
// A stable local name, so bin_paths.py and packaging never track the
// upstream filename.
const modelPath = path.join(vendorDir, 'speaker-embedding.onnx');

if (fs.existsSync(modelPath)) {
    const existingHash = crypto.createHash('sha256').update(fs.readFileSync(modelPath)).digest('hex');
    if (existingHash === MODEL_SHA256) {
        console.log(`speaker-embedding.onnx already present at ${vendorDir}, skipping download.`);
        process.exit(0);
    }
    console.log('Vendored speaker model does not match the pinned checksum — re-fetching.');
}

console.log(`Downloading ${MODEL_URL} ...`);
const response = await fetch(MODEL_URL);
if (!response.ok) {
    console.error(`Download failed: HTTP ${response.status}`);
    process.exit(1);
}
const buffer = Buffer.from(await response.arrayBuffer());

console.log('Verifying checksum...');
const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
if (actualHash !== MODEL_SHA256) {
    console.error(
        `Checksum mismatch for downloaded model at ${MODEL_URL}.\n` +
        `  expected: ${MODEL_SHA256}\n` +
        `  actual:   ${actualHash}\n` +
        `Refusing to keep a file that does not match the pinned checksum.`,
    );
    process.exit(1);
}
console.log('Checksum OK.');

fs.mkdirSync(vendorDir, { recursive: true });
const tmpPath = modelPath + '.part';
fs.writeFileSync(tmpPath, buffer);
fs.renameSync(tmpPath, modelPath);

console.log(`speaker-embedding.onnx (${buffer.length} bytes) ready at ${vendorDir}`);
