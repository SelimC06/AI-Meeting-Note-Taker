import fs from 'node:fs';
import path from 'node:path';
import { bundleVcRuntime, VC_RUNTIME_DLLS } from './vc-runtime.mjs';

// electron-builder `beforePack` hook (package.json build.beforePack).
//
// electron-builder only WARNS ("file source doesn't exist") about a missing
// extraResources source and packages the app without it -- which is how a
// fresh-clone build shipped without the built-in AI's llama-server and the
// speaker-ID model while a dev machine's already-populated vendor/ hid it.
// Every extraResources entry here is load-bearing (the frozen backend,
// ffmpeg, llama-server, the speaker model), so a missing or empty one fails
// the build instead -- for `npm run dist`, `npm run release`, CI and a bare
// `npx electron-builder` alike. It runs before anything is packaged, and
// release.mjs only uploads after electron-builder succeeded.
export function missingExtraResources(projectDir, entries) {
    return (entries ?? [])
        .map((entry) => entry?.from)
        .filter((from) => typeof from === 'string')
        .filter((from) => {
            const src = path.resolve(projectDir, from);
            if (!fs.existsSync(src)) return true;
            return fs.statSync(src).isDirectory() && fs.readdirSync(src).length === 0;
        });
}

// Windows only: put the Microsoft C++ runtime next to llama-server.exe
// (vendor/llama is shipped as resources/llama), from the newest copy on the
// build machine -- its System32 (a CI runner and most dev PCs have the
// redistributable) or the frozen backend PyInstaller produced. Returns the
// DLLs still missing from vendor/llama afterwards (none, or bundleVcRuntime
// threw), so the check below can report them like any missing resource.
export function ensureVcRuntime(projectDir, { systemRoot = process.env.SystemRoot } = {}) {
    const targetDir = path.join(projectDir, 'vendor', 'llama');
    const searchDirs = [
        ...(systemRoot ? [path.join(systemRoot, 'System32')] : []),
        path.join(projectDir, 'backend-dist', 'app-backend', '_internal'),
        path.join(projectDir, 'backend-dist', 'app-backend'),
    ];
    const report = bundleVcRuntime({ targetDir, searchDirs });
    for (const { name, source, version } of report) {
        console.log(`  • VC runtime ${name} ${version.join('.')} <- ${source}`);
    }
    return VC_RUNTIME_DLLS.filter((name) => !fs.existsSync(path.join(targetDir, name)));
}

export default function beforePack({ packager, electronPlatformName }) {
    if (electronPlatformName === 'win32') {
        const missingRuntime = ensureVcRuntime(packager.projectDir);
        if (missingRuntime.length > 0) {
            throw new Error(`vendor/llama is missing the C++ runtime: ${missingRuntime.join(', ')}.`);
        }
    }
    const missing = missingExtraResources(packager.projectDir, [
        ...(packager.config.extraResources ?? []),
        ...(packager.platformSpecificBuildOptions?.extraResources ?? []),
    ]);
    if (missing.length > 0) {
        throw new Error(
            `extraResources missing or empty: ${missing.join(', ')}. ` +
            'Run `npm run build:backend` and `npm run fetch:vendor` first.',
        );
    }
}
