import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function resolveVenvPython(projectRoot, platform = process.platform) {
    const venvDir = path.join(projectRoot, '.venv');
    const pythonPath = platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
    return fs.existsSync(pythonPath) ? pythonPath : null;
}

export function resolveBackendCommand(projectRoot, resourcesPath, isPackaged, platform = process.platform) {
    if (isPackaged) {
        const exeName = platform === 'win32' ? 'app-backend.exe' : 'app-backend';
        const backendDir = path.join(resourcesPath, 'backend');
        return { command: path.join(backendDir, exeName), args: [], cwd: backendDir };
    }
    const pythonExe = resolveVenvPython(projectRoot, platform);
    if (!pythonExe) return null;
    return { command: pythonExe, args: ['-m', 'app.server'], cwd: path.join(projectRoot, 'backend') };
}

let backendProcess = null;
let backendLogTail = [];
let intentionalStop = false;
const BACKEND_LOG_TAIL_MAX_LINES = 20;

export function startBackend(command, args, cwd, env = process.env) {
    intentionalStop = false;
    backendLogTail = [];
    backendProcess = spawn(command, args, { cwd, env });
    backendProcess.stdout.on('data', (data) => {
        console.log(`[backend] ${data.toString().trimEnd()}`);
    });
    backendProcess.stderr.on('data', (data) => {
        const text = data.toString().trimEnd();
        console.error(`[backend] ${text}`);
        backendLogTail.push(...text.split('\n'));
        if (backendLogTail.length > BACKEND_LOG_TAIL_MAX_LINES) {
            backendLogTail = backendLogTail.slice(-BACKEND_LOG_TAIL_MAX_LINES);
        }
    });
    backendProcess.on('error', (err) => {
        console.error(`[backend] failed to start: ${err.message}`);
    });
    return backendProcess;
}

export function getBackendLogTail() {
    return backendLogTail.join('\n');
}

// Tree-kills a process on Windows (taskkill /T) so ffmpeg grandchildren the
// backend spawned die with it instead of surviving as orphans -- a plain
// .kill() only ever signals the direct child. Falls back to a plain kill if
// taskkill itself fails (process already gone, no permissions, etc.) so the
// child isn't left dangling either way.
async function killProcessTree(pid, platform) {
    if (platform === 'win32') {
        try {
            await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
            return;
        } catch {
            // fall through to a plain kill below
        }
    }
    try {
        process.kill(pid);
    } catch {
        // already gone
    }
}

export async function stopBackend(platform = process.platform) {
    intentionalStop = true;
    const proc = backendProcess;
    backendProcess = null;
    if (!proc || proc.exitCode !== null || proc.killed) return;
    await killProcessTree(proc.pid, platform);
}

export function armCrashMonitor(childProcess, onCrash) {
    const listener = (code, signal) => {
        if (intentionalStop) return;
        onCrash(code, signal);
    };
    childProcess.once('exit', listener);
    return listener;
}

export function disarmCrashMonitor(childProcess, listener) {
    childProcess.removeListener('exit', listener);
}

async function findPidsListeningOnPort(port, platform) {
    if (platform === 'win32') {
        let stdout;
        try {
            ({ stdout } = await execFileAsync('netstat', ['-ano']));
        } catch {
            return [];
        }
        const pids = new Set();
        for (const line of stdout.split('\n')) {
            const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
            if (match && Number(match[1]) === port) {
                pids.add(Number(match[2]));
            }
        }
        return [...pids];
    }
    try {
        const { stdout } = await execFileAsync('lsof', ['-t', '-i', `tcp:${port}`, '-sTCP:LISTEN']);
        return stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map(Number);
    } catch {
        return [];
    }
}

// Resolves the on-disk executable backing a running PID, so ensurePortFree can tell a
// previous instance of *our own* backend apart from some unrelated process (a user's own
// dev server, etc.) that happens to be listening on the same port.
export async function getProcessExecutablePath(pid, platform = process.platform) {
    if (platform === 'win32') {
        try {
            const { stdout } = await execFileAsync('powershell', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).Path`,
            ]);
            return stdout.trim() || null;
        } catch {
            return null;
        }
    }
    try {
        return await fs.promises.readlink(`/proc/${pid}/exe`);
    } catch {
        return null;
    }
}

function samePath(a, b) {
    if (!a || !b) return false;
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// A prior launch's backend process can outlive its Electron parent (crash, force-close,
// or a kill that didn't propagate) and stay bound to the backend port. Every later launch
// then health-checks successfully against that stale process while the freshly spawned one
// fails to bind and crash-loops forever. Clearing the port before every spawn — both the
// initial launch and each crash-recovery attempt — makes this self-healing.
//
// But a PID listening on the port isn't necessarily ours — a user could have their own dev
// server bound to :8000. Only PIDs whose executable matches expectedExePath (the exact
// command we're about to spawn) are killed; anything else is left alone, and the port is
// reported as still occupied (false) so the caller can fall back to a different port instead
// of silently terminating someone else's process.
//
// After sending the kill signal, the OS can take a while to actually release the socket —
// measured against the real frozen backend binary, this took ~600ms, well past any short
// fixed delay. So we poll for the port to actually be free rather than guessing a duration.
export async function ensurePortFree(
    port,
    expectedExePath,
    platform = process.platform,
    releaseTimeoutMs = 5000,
    getExecutablePathFn = getProcessExecutablePath
) {
    const pids = await findPidsListeningOnPort(port, platform);
    if (pids.length === 0) return true;

    let killedAny = false;
    for (const pid of pids) {
        const exePath = await getExecutablePathFn(pid, platform);
        if (!samePath(exePath, expectedExePath)) continue;
        await killProcessTree(pid, platform);
        killedAny = true;
    }

    if (killedAny) {
        const deadline = Date.now() + releaseTimeoutMs;
        while (Date.now() < deadline) {
            const stillListening = await findPidsListeningOnPort(port, platform);
            if (stillListening.length === 0) return true;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    const remaining = await findPidsListeningOnPort(port, platform);
    return remaining.length === 0;
}

export function waitForHealth(url, timeoutMs, childProcess = null) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        let settled = false;
        let interval;

        const finish = (fn) => {
            if (settled) return;
            settled = true;
            clearInterval(interval);
            if (childProcess) {
                childProcess.removeListener('exit', onExit);
                childProcess.removeListener('error', onError);
            }
            fn();
        };

        const onExit = (code) => {
            finish(() => reject(new Error(`backend process exited before becoming healthy (code ${code})`)));
        };

        const onError = (err) => {
            finish(() => reject(new Error(`backend process failed to start: ${err.message}`)));
        };

        if (childProcess) {
            childProcess.once('exit', onExit);
            childProcess.once('error', onError);
        }

        const attempt = async () => {
            if (settled) return;
            try {
                const res = await fetch(`${url}/health`);
                if (res.ok) {
                    finish(resolve);
                    return;
                }
            } catch {
                // backend not accepting connections yet, keep polling
            }
            if (!settled && Date.now() - start >= timeoutMs) {
                finish(() => reject(new Error(`backend did not become healthy within ${timeoutMs}ms`)));
            }
        };

        interval = setInterval(attempt, 500);
        attempt();
    });
}
