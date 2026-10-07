import fs from 'node:fs';
import path from 'node:path';

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

export default function beforePack({ packager }) {
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
