// The public URL electron-updater reads releases from (a custom domain in
// front of the R2 bucket). Its own module, with no Electron imports, so
// scripts/release.mjs can read the same value in plain Node to check what's
// already published -- updater.js imports electron-updater, which needs
// Electron at load time.
export const DEFAULT_FEED_URL = 'https://updates.deskrecap.com';

export function getUpdateFeedUrl(env = process.env) {
    return env.UPDATE_FEED_URL || DEFAULT_FEED_URL;
}

// Where to send Mac users for a new version: ad-hoc-signed builds can't be
// installed by Squirrel.Mac (see updater.js), so they download it instead.
export const WEBSITE_URL = 'https://deskrecap.com';

// electron-builder's update manifest name per platform.
export function manifestNameForPlatform(platform) {
    if (platform === 'darwin') return 'latest-mac.yml';
    if (platform === 'win32') return 'latest.yml';
    return 'latest-linux.yml';
}
