import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const venvDir = path.join(projectRoot, '.venv');

function run(command, args, opts = {}) {
    console.log(`> ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, { stdio: 'inherit', ...opts });
    if (result.status !== 0) {
        console.error(`Command failed: ${command} ${args.join(' ')}`);
        process.exit(result.status ?? 1);
    }
}

// requirements.txt (fastapi, faster-whisper) needs 3.9+. macOS ships /usr/bin/python3
// as 3.8 from the Xcode command line tools, and it answers to both "python3" and
// "python" -- so picking the first interpreter that merely *runs* built a venv that
// every `pip install` then failed against, leaving the backend to die at import time
// with ModuleNotFoundError. Probe newest-first and check the actual version instead.
const MIN_PYTHON = [3, 9];
const PYTHON_CANDIDATES = [
    'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3', 'python',
];

function pythonVersion(candidate) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {
        encoding: 'utf8',
    });
    if (probe.status !== 0) return null;
    const [major, minor] = probe.stdout.trim().split('.').map(Number);
    return Number.isFinite(major) && Number.isFinite(minor) ? [major, minor] : null;
}

function findSystemPython() {
    const tooOld = [];
    for (const candidate of PYTHON_CANDIDATES) {
        const version = pythonVersion(candidate);
        if (!version) continue;
        const [major, minor] = version;
        if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) {
            console.log(`Using ${candidate} (Python ${major}.${minor}).`);
            return candidate;
        }
        tooOld.push(`${candidate} (Python ${major}.${minor})`);
    }
    console.error(
        `No Python ${MIN_PYTHON.join('.')}+ found on PATH (tried: ${PYTHON_CANDIDATES.join(', ')}).`
        + (tooOld.length ? `\nFound but too old: ${tooOld.join(', ')}.` : '')
        + '\nInstall a newer Python (on macOS: `brew install python@3.12`) and re-run.',
    );
    process.exit(1);
}

const venvPython = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');

if (fs.existsSync(venvDir)) {
    // An existing venv can be built on a Python too old for requirements.txt (see
    // findSystemPython above) -- reusing it silently just reproduces the install
    // failure it was created with, so refuse instead of skipping past it.
    const version = pythonVersion(venvPython);
    if (!version || version[0] < MIN_PYTHON[0] || (version[0] === MIN_PYTHON[0] && version[1] < MIN_PYTHON[1])) {
        console.error(
            `${venvDir} exists but its Python is ${version ? version.join('.') : 'unusable'}, `
            + `and requirements.txt needs ${MIN_PYTHON.join('.')}+.\n`
            + `Delete it and re-run: rm -rf "${venvDir}"`,
        );
        process.exit(1);
    }
    console.log(`.venv already exists at ${venvDir} (Python ${version.join('.')}), skipping creation.`);
} else {
    const systemPython = findSystemPython();
    run(systemPython, ['-m', 'venv', venvDir]);
}

// requirements.lock pins everything requirements-dev.txt and
// requirements-build.txt pull in (runtime deps, pytest/ruff/uv, PyInstaller)
// to exact hash-checked versions for macOS and Windows, so every venv -- a
// dev machine, CI, the release build -- gets identical packages. Only what
// the backend actually imports ends up in the frozen app (build:backend).
// The hashes make pip refuse any file that doesn't match the lock.
run(venvPython, ['-m', 'pip', 'install', '--require-hashes', '-r', path.join(projectRoot, 'requirements.lock')]);

console.log('Backend venv ready.');
