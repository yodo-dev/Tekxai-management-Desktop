const { notarize } = require('@electron/notarize');

// electron-builder afterSign hook — signing (identity in package.json) only
// gets Gatekeeper to trust *who* built the app. Since Catalina, anything
// downloaded from the internet (quarantine xattr set) also needs Apple to
// have scanned and stamped it via notarization, or Gatekeeper rejects it
// with "could not verify ... free of malware" regardless of a valid
// signature. Credentials come from env vars, never hardcoded.
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.warn(
      '[notarize] Skipping notarization: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set. ' +
      'The resulting .dmg will be signed but Gatekeeper will still reject it on other Macs.'
    );
    return;
  }

  console.log(`[notarize] Submitting ${appPath} to Apple notary service...`);
  await notarize({
    appBundleId: 'com.tekxaierp.app',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('[notarize] Done — app is notarized.');
};
