import { notarize } from '@electron/notarize';

export default async function afterSign(context) {
    if (context.electronPlatformName !== 'darwin') return;

    const requiredVars = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
    const missing = requiredVars.filter((name) => !process.env[name]);
    if (missing.length > 0) {
        console.log(
            `Skipping notarization (unsigned local build): missing ${missing.join(', ')}.`
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
