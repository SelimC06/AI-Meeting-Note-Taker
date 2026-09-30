import { notarize } from '@electron/notarize';

// DeskRecap's Mac builds are ad-hoc signed (build.mac.identity "-") on
// purpose and for good: there is no Apple Developer ID, and there won't be
// one. Apple only notarizes apps signed with a Developer ID, so sending an
// ad-hoc build is guaranteed to fail -- after a multi-minute upload -- and
// fail the whole release with it. This hook therefore never notarizes an
// ad-hoc build, whatever APPLE_API_* happens to be set in the environment.
// What ad-hoc builds mean for users (Open Anyway on first launch, no
// in-app auto-update) is documented in the README.
export function isAdHocSigned(context) {
    const macOptions = context.packager?.platformSpecificBuildOptions ?? context.packager?.config?.mac ?? {};
    return macOptions.identity === '-';
}

export default async function afterSign(context) {
    if (context.electronPlatformName !== 'darwin') return;

    if (isAdHocSigned(context)) {
        console.log('Skipping notarization: this is an ad-hoc-signed build (build.mac.identity "-"), which Apple cannot notarize.');
        return;
    }

    const requiredVars = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
    const missing = requiredVars.filter((name) => !process.env[name]);
    if (missing.length > 0) {
        console.log(
            `Skipping notarization: missing ${missing.join(', ')}.`
        );
        return;
    }

    const appName = context.packager.appInfo.productFilename;
    await notarize({
        appBundleId: context.packager.appInfo.id,
        appPath: `${context.appOutDir}/${appName}.app`,
        appleApiKey: process.env.APPLE_API_KEY,
        appleApiKeyId: process.env.APPLE_API_KEY_ID,
        appleApiIssuer: process.env.APPLE_API_ISSUER,
    });
}
