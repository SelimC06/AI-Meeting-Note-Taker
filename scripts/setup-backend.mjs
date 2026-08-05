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

function findSystemPython() {
    for (const candidate of ['python', 'python3']) {
        const probe = spawnSync(candidate, ['--version']);
        if (probe.status === 0) return candidate;
    }
    console.error('No system Python found on PATH (tried "python", "python3").');
    process.exit(1);
}

if (fs.existsSync(venvDir)) {
    console.log(`.venv already exists at ${venvDir}, skipping creation.`);
} else {
    const systemPython = findSystemPython();
    run(systemPython, ['-m', 'venv', venvDir]);
}

const venvPython = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');

run(venvPython, ['-m', 'pip', 'install', '-r', path.join(projectRoot, 'requirements.txt')]);

console.log('Backend venv ready.');
