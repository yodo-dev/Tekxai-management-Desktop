const { notarize } = require('@electron/notarize');

module.exports = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appleApiKeyId     = process.env.APPLE_API_KEY_ID;
  const appleApiIssuer    = process.env.APPLE_API_ISSUER;
  const appleApiKeyPath   = process.env.APPLE_API_KEY_PATH;

  if (!appleApiKeyId || !appleApiIssuer || !appleApiKeyPath) {
    console.warn('[notarize] Skipping — APPLE_API_KEY_ID / APPLE_API_ISSUER / APPLE_API_KEY_PATH not set');
    return;
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
