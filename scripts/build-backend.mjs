import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const venvDir = path.join(projectRoot, '.venv');
const backendDir = path.join(projectRoot, 'backend');
const distDir = path.join(projectRoot, 'backend-dist');
const workDir = path.join(projectRoot, 'build', 'pyinstaller');

function run(command, args, opts = {}) {
    console.log(`> ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, { stdio: 'inherit', ...opts });
    if (result.status !== 0) {
        console.error(`Command failed: ${command} ${args.join(' ')}`);
        process.exit(result.status ?? 1);
    }
}

const venvPython = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
if (!fs.existsSync(venvPython)) {
    console.error(`No .venv found at ${venvDir}. Run "npm run setup:backend" first.`);
    process.exit(1);
}

// Always (not only when PyInstaller is missing): installing requirements.lock
// is a quick no-op when the venv already matches, and it brings anything that
// drifted (an older/newer PyInstaller, a stray upgrade) back to the exact,
// hash-checked versions the release is built and tested with.
run(venvPython, ['-m', 'pip', 'install', '--require-hashes', '-r', path.join(projectRoot, 'requirements.lock')]);

if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
}

run(venvPython, [
    '-m', 'PyInstaller',
    'run_server.py',
    '--name', 'app-backend',
    '--onedir',
    '--noconfirm',
    '--distpath', distDir,
    '--workpath', workDir,
    '--hidden-import', 'uvicorn.logging',
    '--hidden-import', 'uvicorn.loops.auto',
    '--hidden-import', 'uvicorn.protocols.http.auto',
    '--hidden-import', 'uvicorn.protocols.websockets.auto',
    '--hidden-import', 'uvicorn.lifespan.on',
    '--hidden-import', 'multipart',
    '--hidden-import', 'ollama',
    '--hidden-import', 'PIL',
    '--collect-all', 'faster_whisper',
    '--collect-all', 'sherpa_onnx',
    '--collect-all', 'ctranslate2',
    '--collect-binaries', 'ctranslate2',
    '--copy-metadata', 'faster_whisper',
    '--copy-metadata', 'ctranslate2',
    '--copy-metadata', 'huggingface_hub',
    '--copy-metadata', 'tokenizers',
], { cwd: backendDir });

console.log(`Backend frozen at ${path.join(distDir, 'app-backend')}`);
