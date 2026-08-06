const { notarize } = require('@electron/notarize');

// electron-builder afterAllArtifactBuild hook — notarize.js (afterSign) only
// notarizes+staples the .app bundle, which happens *before* the .dmg is
// built around it. Apple's ticket is issued per-artifact by content hash, so
// the .dmg -- a distinct file -- was never submitted and has no ticket of
// its own to staple; `xcrun stapler staple` on it fails with "Record not
// found". @electron/notarize's notarize() does submit+staple in one call
// (staple defaults to true), so just point it at the .dmg directly instead
// of trying to staple a ticket that was never requested.
exports.default = async function afterAllArtifactBuild(buildResult) {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) return [];

  // electron-builder passes a BuildResult object here, not a bare array —
  // the actual artifact file paths are on `.artifactPaths`.
  const dmgPaths = (buildResult.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  for (const dmgPath of dmgPaths) {
    console.log(`[staple-dmg] Submitting ${dmgPath} to Apple notary service...`);
    await notarize({
      appBundleId: 'com.tekxaierp.app',
      appPath: dmgPath,
      appleId: APPLE_ID,
      appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
      teamId: APPLE_TEAM_ID,
    });
    console.log(`[staple-dmg] Done — ${dmgPath} is notarized and stapled.`);
  }
  return [];
};
