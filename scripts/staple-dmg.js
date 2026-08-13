const { notarize } = require('@electron/notarize');

// electron-builder afterAllArtifactBuild hook — notarize.js (afterSign) only
// notarizes+staples the .app bundle, which happens *before* the .dmg is
// built around it. Apple's ticket is issued per-artifact by content hash, so
// the .dmg -- a distinct file -- was never submitted and has no ticket of
// its own to staple; `xcrun stapler staple` on it fails with "Record not
// found". @electron/notarize's notarize() does submit+staple in one call
// (staple defaults to true), so just point it at the .dmg directly instead
// of trying to staple a ticket that was never requested.
//
// Stapling rewrites the .dmg in place (embeds the ticket), which changes its
// bytes, so latest-mac.yml's DMG entry needs the same fixup — but NOT here.
// electron-builder computes+queues that entry's sha512/size the moment the
// DMG artifact is first created (pre-staple), and only actually writes
// latest-mac.yml to disk *after* this afterAllArtifactBuild hook's promise
// resolves (PublishManager.awaitTasks() -> writeUpdateInfoFiles(), called
// from the outer executeFinally in app-builder-lib's index.js — not exposed
// as a hook). So latest-mac.yml doesn't even exist on disk yet at the point
// this hook runs, and patching it from here either no-ops silently or gets
// clobbered by that later write. See scripts/sync-update-yml.js, run as a
// separate step in package.json's build:mac *after* electron-builder fully
// exits, for the actual fix.
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
