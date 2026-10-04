import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Per-launch shared secret between this process, the backend and the
// renderers (see ApiAuthMiddleware in backend/app/server.py): the backend
// listens on 127.0.0.1, which every web page the user visits can also
// reach, so it only trusts requests that echo this back in
// BACKEND_TOKEN_HEADER. Handed to the backend via BACKEND_TOKEN_ENV and to
// the renderers via preload.js; never written to disk.
export const BACKEND_TOKEN_ENV = 'DESKRECAP_API_TOKEN';
export const BACKEND_TOKEN_HEADER = 'X-DeskRecap-Token';

export function generateBackendToken() {
    return crypto.randomBytes(32).toString('hex');
}

export function backendAuthHeaders(token) {
    return token ? { [BACKEND_TOKEN_HEADER]: token } : {};
}

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

export function resolveFfmpegPaths(resourcesPath, platform = process.platform) {
    const ext = platform === 'win32' ? '.exe' : '';
    const ffmpegDir = path.join(resourcesPath, 'ffmpeg');
    return {
        ffmpegBin: path.join(ffmpegDir, `ffmpeg${ext}`),
        ffprobeBin: path.join(ffmpegDir, `ffprobe${ext}`),
    };
}

// The bundled llama.cpp server binary (vendored by scripts/fetch-llama.mjs,
// shipped via extraResources exactly like ffmpeg above). The backend reads
// it from the LLAMA_SERVER_BIN env var (see backend/app/bin_paths.py, which
// also knows the dev-checkout vendor/llama fallback for unpackaged runs).
export function resolveLlamaServerPath(resourcesPath, platform = process.platform) {
    const exe = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    return path.join(resourcesPath, 'llama', exe);
}

// The bundled speaker-embedding ONNX model (vendored by
// scripts/fetch-speaker-model.mjs), read by the backend via
// SPEAKER_MODEL_PATH -- same scheme as ffmpeg/llama above. Architecture
// independent, so one path for every platform.
export function resolveSpeakerModelPath(resourcesPath) {
    return path.join(resourcesPath, 'speaker', 'speaker-embedding.onnx');
}

let backendProcess = null;
let backendLogTail = [];
const BACKEND_LOG_TAIL_MAX_LINES = 20;

// Children whose exit was asked for (stopBackend, or being replaced by a
// newer startBackend) -- armCrashMonitor ignores their exit. Per child
// rather than one module-wide flag: startBackend used to reset a single
// flag, so an old child still dying after a new one was spawned (Retry
// after a startup timeout) looked like a crash and kicked off recovery.
const intentionallyStopped = new WeakSet();

// Every backend child that hasn't exited yet, including ones mid-stop --
// what killAllBackendsSync (the process 'exit' hook) must not leave behind.
const liveChildren = new Set();

// How long a stop waits after SIGTERM before SIGKILL. uvicorn's SIGTERM
// handler only sets a "should exit" flag that its event loop polls, so a
// deadlocked backend never acts on it -- without escalation it (and the
// ffmpeg it spawned) lived on holding the port.
export const STOP_GRACE_MS = 5000;

// detached on macOS/Linux makes the backend the leader of its own process
// group (setsid), so stopping it can signal the whole group -- ffmpeg
// children included -- with process.kill(-pid). Not on Windows, where
// detached opens a separate console window instead; taskkill /T already
// walks the tree there. A detached child no longer dies with Electron's
// process group, which is what killAllBackendsSync and main.js's awaited
// stop in before-quit are for.
export function backendSpawnOptions(cwd, env, platform = process.platform) {
    return { cwd, env, detached: platform !== 'win32' };
}

export function startBackend(command, args, cwd, env = process.env, platform = process.platform) {
    // Never leave a previous child running untracked: after a startup
    // timeout it can still be alive (slow cold start), and a Retry used to
    // overwrite backendProcess, orphaning it. Signalled right away (the
    // SIGTERM/taskkill goes out synchronously) but not awaited, since this
    // is synchronous; attemptRecovery awaits stopBackend() before spawning
    // for exactly this reason, so the port is actually released first.
    const previous = backendProcess;
    if (previous) {
        stopChild(previous, platform).catch(() => {});
    }
    backendLogTail = [];
    const child = spawn(command, args, backendSpawnOptions(cwd, env, platform));
    backendProcess = child;
    liveChildren.add(child);
    child.once('exit', () => {
        liveChildren.delete(child);
        // The backend is gone but anything it spawned is still in its
        // group (ffmpeg mid-mux after a crash). Signalled right at exit,
        // while the group id can't have been reused yet.
        if (platform !== 'win32') {
            try {
                process.kill(-child.pid, 'SIGTERM');
            } catch {
                // no group members left
            }
        }
    });
    child.stdout.on('data', (data) => {
        console.log(`[backend] ${data.toString().trimEnd()}`);
    });
    child.stderr.on('data', (data) => {
        const text = data.toString().trimEnd();
        console.error(`[backend] ${text}`);
        backendLogTail.push(...text.split('\n'));
        if (backendLogTail.length > BACKEND_LOG_TAIL_MAX_LINES) {
            backendLogTail = backendLogTail.slice(-BACKEND_LOG_TAIL_MAX_LINES);
        }
    });
    child.on('error', (err) => {
        liveChildren.delete(child);
        console.error(`[backend] failed to start: ${err.message}`);
    });
    return child;
}

export function getBackendLogTail() {
    return backendLogTail.join('\n');
}

// Sends `signal` to pid's process group if it leads one (every backend
// spawned by startBackend on macOS/Linux), else to pid alone -- an orphan
// left by an older build, spawned before detached:true, isn't a group
// leader, and -pid then fails with ESRCH. -pid only ever addresses the
// group pid itself leads, so this can't hit an unrelated group. Returns the
// target that was signalled (-pid or pid), or null if nothing was there.
function signalTree(pid, signal) {
    try {
        process.kill(-pid, signal);
        return -pid;
    } catch {
        // not a group leader (or group already empty) -- try the pid alone
    }
    try {
        process.kill(pid, signal);
        return pid;
    } catch {
        return null;
    }
}

function isAlive(target) {
    try {
        process.kill(target, 0);
        return true;
    } catch (err) {
        // EPERM: it exists, we just can't signal it.
        return err.code === 'EPERM';
    }
}

// Kills a process and everything it spawned, so ffmpeg grandchildren die
// with the backend instead of surviving as orphans (a plain .kill() only
// ever signals the direct child).
// - Windows: taskkill /T /F (already forceful, so no escalation). Falls
//   back to a plain kill if taskkill itself fails (process already gone, no
//   permissions, etc.) so the child isn't left dangling either way.
// - macOS/Linux: SIGTERM to the process group, then SIGKILL if anything in
//   it is still alive after graceMs (see STOP_GRACE_MS). Resolves once the
//   group is gone or SIGKILL has been sent.
export async function killProcessTree(pid, platform = process.platform, graceMs = STOP_GRACE_MS) {
    if (platform === 'win32') {
        try {
            await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
            return;
        } catch {
            // fall through to a plain kill below
        }
        try {
            process.kill(pid);
        } catch {
            // already gone
        }
        return;
    }
    const target = signalTree(pid, 'SIGTERM');
    if (target === null) return;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
        if (!isAlive(target)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
        process.kill(target, 'SIGKILL');
    } catch {
        // exited right at the deadline
    }
}

async function stopChild(proc, platform, graceMs = STOP_GRACE_MS) {
    intentionallyStopped.add(proc);
    // Already exited: its leftover group members were signalled from the
    // 'exit' listener in startBackend. Signalling the bare pid now could hit
    // an unrelated process that has since reused it.
    if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return;
    await killProcessTree(proc.pid, platform, graceMs);
}

// Resolves once the backend (and, on macOS/Linux, its whole process group)
// has exited or been SIGKILLed -- not merely once a signal was sent -- so a
// caller can rely on the port being released afterward.
export async function stopBackend(platform = process.platform, graceMs = STOP_GRACE_MS) {
    const proc = backendProcess;
    backendProcess = null;
    if (!proc) return;
    await stopChild(proc, platform, graceMs);
}

// Last-resort, synchronous: for process.on('exit') in main.js, where no
// async work can run any more. Kills every backend child that's still
// alive -- including one a pending stopBackend was still waiting on the
// SIGKILL deadline for -- so a detached backend never outlives Electron
// (an app.exit(), a crash exit, or a quit that didn't wait for the stop).
export function killAllBackendsSync(platform = process.platform) {
    for (const child of liveChildren) {
        intentionallyStopped.add(child);
        if (!child.pid) continue;
        if (platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
            signalTree(child.pid, 'SIGKILL');
        }
    }
}

export function armCrashMonitor(childProcess, onCrash) {
    const listener = (code, signal) => {
        if (intentionallyStopped.has(childProcess)) return;
        onCrash(code, signal);
    };
    childProcess.once('exit', listener);
    return listener;
}

export function disarmCrashMonitor(childProcess, listener) {
    childProcess.removeListener('exit', listener);
}

export async function findPidsListeningOnPort(port, platform, execFileAsyncFn = execFileAsync) {
    if (platform === 'win32') {
        // Get-NetTCPConnection returns structured objects, so this is immune
        // to the localized state names netstat prints on non-English Windows
        // (LISTENING -> ABHÖREN etc.), which the old regex silently never
        // matched -- reporting an orphan-held port as free.
        try {
            const { stdout } = await execFileAsyncFn('powershell', [
                '-NoProfile', '-NonInteractive', '-Command',
                `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction Stop).OwningProcess`,
            ]);
            return [...new Set(
                stdout.split('\n').map((l) => l.trim()).filter(Boolean).map(Number).filter(Number.isFinite)
            )];
        } catch {
            // Get-NetTCPConnection throws when there are no matching
            // connections -- that's the normal "port is free" case -- or PS
            // is unavailable; either way, treat it as no listeners found.
            return [];
        }
    }
    try {
        const { stdout } = await execFileAsyncFn('lsof', ['-t', '-i', `tcp:${port}`, '-sTCP:LISTEN']);
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
export async function getProcessExecutablePath(pid, platform = process.platform, execFileAsyncFn = execFileAsync) {
    if (platform === 'win32') {
        try {
            const { stdout } = await execFileAsyncFn('powershell', [
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
    if (platform === 'darwin') {
        // macOS has no /proc; `ps -o comm=` prints the full path for a
        // process launched by absolute path (our own backend always is --
        // see resolveBackendCommand), same as the `lsof`-based listener
        // lookup in findPidsListeningOnPort above already assumes for macOS.
        try {
            const { stdout } = await execFileAsyncFn('ps', ['-p', String(pid), '-o', 'comm=']);
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
// Cheap (~1ms, no process spawn) "is anything listening" probe: binding
// succeeds only if the port is actually free. Can't say WHOSE process holds
// an occupied port -- that still needs the PowerShell-backed
// findPidsListeningOnPort below, kept for the kill decision.
function probePortFree(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        // Must match the backend's own bind address (127.0.0.1, see
        // server.py's uvicorn.run) -- binding with no host at all listens on
        // every interface (0.0.0.0 / ::), which on Windows can succeed
        // alongside another process already bound to just 127.0.0.1,
        // reporting an occupied port as free.
        srv.listen(port, '127.0.0.1', () => {
            srv.close(() => resolve(true));
        });
    });
}

export async function ensurePortFree(
    port,
    expectedExePath,
    platform = process.platform,
    releaseTimeoutMs = 5000,
    getExecutablePathFn = getProcessExecutablePath
) {
    // The common case on every startup: the port is already free, and the
    // bind probe answers that without ever spawning powershell.exe (a
    // 0.5-3s cold start) on the startup critical path.
    if (await probePortFree(port)) return true;

    const pids = await findPidsListeningOnPort(port, platform);
    if (pids.length === 0) return true;

    let killedAny = false;
    for (const pid of pids) {
        const exePath = await getExecutablePathFn(pid, platform);
        if (!samePath(exePath, expectedExePath)) continue;
        await killProcessTree(pid, platform);
        killedAny = true;
    }

    // Nothing we own was holding the port -- the listing above already
    // answered the question, so skip the redundant final re-query.
    if (!killedAny) return false;

    const deadline = Date.now() + releaseTimeoutMs;
    while (Date.now() < deadline) {
        if (await probePortFree(port)) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return probePortFree(port);
}

export const HEALTH_ATTEMPT_TIMEOUT_MS = 3000;

// authToken is required against a real backend -- /health is not exempt
// from the token check, which also means a 200 here proves the port is held
// by the backend this launch spawned, not some other process.
export function waitForHealth(url, timeoutMs, childProcess = null, authToken = null) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        let settled = false;
        let interval;
        let attemptInFlight = false;

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
            if (settled || attemptInFlight) return;
            attemptInFlight = true;
            // Cap the abort at whatever's left of the overall deadline, so a
            // single slow/hung attempt can't itself push the rejection past
            // timeoutMs -- the deadline is only re-checked once an attempt
            // settles, so the attempt must never outlive the deadline.
            const remainingMs = timeoutMs - (Date.now() - start);
            const attemptTimeoutMs = Math.max(1, Math.min(HEALTH_ATTEMPT_TIMEOUT_MS, remainingMs));
            try {
                const res = await fetch(`${url}/health`, {
                    headers: backendAuthHeaders(authToken),
                    signal: AbortSignal.timeout(attemptTimeoutMs),
                });
                if (res.ok) {
                    finish(resolve);
                    return;
                }
            } catch {
                // backend not accepting connections yet (or the per-attempt
                // timeout fired), keep polling
            } finally {
                attemptInFlight = false;
            }
            if (!settled && Date.now() - start >= timeoutMs) {
                finish(() => reject(new Error(`backend did not become healthy within ${timeoutMs}ms`)));
            }
        };

        interval = setInterval(attempt, 500);
        attempt();
    });
}
