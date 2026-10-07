import fs from 'node:fs';
import path from 'node:path';

// The Microsoft C++ runtime llama-server.exe and its DLLs import (checked
// against the pinned b11382 Windows build). Windows ships the UCRT
// (api-ms-win-crt-*) itself, but NOT these: they come from the "Visual C++
// Redistributable", which most PCs happen to have (games and other apps
// install it) and clean installs don't -- so without app-local copies the
// built-in AI fails to start on exactly the machines a dev's own test never
// covers. Microsoft licenses these files for app-local redistribution.
export const VC_RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];

// VS_FIXEDFILEINFO starts with this signature (0xFEEF04BD, little-endian);
// dwFileVersionMS / dwFileVersionLS follow at +8 / +12. Reading it directly
// avoids needing Windows tooling (or a PE library) at package time.
const FIXED_FILE_INFO_SIGNATURE = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);

/** [major, minor, build, revision] of a PE file's version resource, or null. */
export function peFileVersion(buffer) {
    const at = buffer.indexOf(FIXED_FILE_INFO_SIGNATURE);
    if (at < 0 || at + 16 > buffer.length) return null;
    const ms = buffer.readUInt32LE(at + 8);
    const ls = buffer.readUInt32LE(at + 12);
    return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff];
}

export function compareVersions(a, b) {
    for (let i = 0; i < 4; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

// Case-insensitive lookup: Windows filesystems are, and System32 has both
// "msvcp140.dll" and "MSVCP140.dll" spellings depending on the installer.
function findInDir(dir, name) {
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return null;
    }
    const hit = entries.find((e) => e.toLowerCase() === name.toLowerCase());
    return hit ? path.join(dir, hit) : null;
}

/**
 * Copy the NEWEST available copy of each VC runtime DLL into targetDir.
 *
 * Newest, not first-found: a binary built with a recent MSVC toolset can
 * crash against an older msvcp140.dll sitting next to it (app-local copies
 * win over System32), and Python's bundled copy is typically older than
 * the toolset upstream llama.cpp builds with. Candidates whose version
 * can't be read rank below any versioned copy.
 *
 * Returns [{ name, source, version }]; throws if any DLL is found nowhere.
 */
export function bundleVcRuntime({ targetDir, searchDirs }) {
    const report = [];
    const missing = [];
    for (const name of VC_RUNTIME_DLLS) {
        let best = null;
        for (const dir of searchDirs) {
            const candidate = findInDir(dir, name);
            if (!candidate) continue;
            const version = peFileVersion(fs.readFileSync(candidate)) ?? [0, 0, 0, 0];
            if (!best || compareVersions(version, best.version) > 0) {
                best = { source: candidate, version };
            }
        }
        if (!best) {
            missing.push(name);
            continue;
        }
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(best.source, path.join(targetDir, name));
        report.push({ name, source: best.source, version: best.version });
    }
    if (missing.length > 0) {
        throw new Error(
            `Microsoft C++ runtime not found for llama-server: ${missing.join(', ')} ` +
            `(searched ${searchDirs.join(', ')}). Install the Visual C++ Redistributable ` +
            '(x64) on the build machine, or rebuild the backend (npm run build:backend).',
        );
    }
    return report;
}
