const { notarize } = require('@electron/notarize');

module.exports = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appleApiKeyId     = process.env.APPLE_API_KEY_ID;
  const appleApiIssuer    = process.env.APPLE_API_ISSUER;
  const appleApiKeyPath   = process.env.APPLE_API_KEY_PATH;

  // A signed-but-unnotarized .app is rejected by Gatekeeper on any Mac it
  // wasn't built on ("has been blocked because it may reduce your privacy").
  // Warning-and-continuing here let exactly that ship silently in the past —
  // fail the build instead, so a missing credential is caught before the
  // dmg/zip is ever produced or uploaded, not discovered later by a user's
  // Gatekeeper prompt.
  if (!appleApiKeyId || !appleApiIssuer || !appleApiKeyPath) {
    throw new Error(
      '[notarize] APPLE_API_KEY_ID / APPLE_API_ISSUER / APPLE_API_KEY_PATH must all be set to build for macOS — ' +
      'an unnotarized build will be rejected by Gatekeeper on every user\'s machine. ' +
      'Set these env vars (App Store Connect API key with Developer role) before running build:mac.'
    );
  }

  console.log(`[notarize] Notarizing ${appName}…`);

  await notarize({
    tool: 'notarytool',
    appPath: `${appOutDir}/${appName}.app`,
    appleApiKey: appleApiKeyPath,
    appleApiKeyId,
    appleApiIssuer,
  });

  console.log('[notarize] Done.');
};
