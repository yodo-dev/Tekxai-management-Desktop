const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Runs as a separate step *after* electron-builder fully exits (see
// package.json build:mac), not as an electron-builder lifecycle hook.
//
// Why: stapling (scripts/staple-dmg.js, afterAllArtifactBuild) rewrites the
// .dmg in place, changing its bytes after electron-builder already computed
// its sha512/size for latest-mac.yml. That write is deferred internally
// (PublishManager.awaitTasks() -> writeUpdateInfoFiles(), called from
// app-builder-lib's outer executeFinally, after afterAllArtifactBuild
// resolves) and isn't exposed as a hook, so latest-mac.yml doesn't exist on
// disk yet while afterAllArtifactBuild runs — patching it from there either
// no-ops or gets clobbered by that later write. Running this once
// electron-builder's process has actually exited guarantees the file exists
// and won't be touched again, so the DMG entry can be corrected in place
// from the real final bytes.
const distDir = path.join(__dirname, '..', 'dist');
const ymlPath = path.join(distDir, 'latest-mac.yml');

if (!fs.existsSync(ymlPath)) {
  console.log('[sync-update-yml] latest-mac.yml not found, skipping.');
  process.exit(0);
}

const doc = yaml.load(fs.readFileSync(ymlPath, 'utf8'));
let changed = false;

for (const entry of doc.files || []) {
  if (!entry.url || !entry.url.endsWith('.dmg')) continue;
  const dmgPath = path.join(distDir, entry.url);
  if (!fs.existsSync(dmgPath)) continue;

  const buf = fs.readFileSync(dmgPath);
  const size = buf.length;
  const sha512 = crypto.createHash('sha512').update(buf).digest('base64');

  if (entry.size !== size || entry.sha512 !== sha512) {
    entry.size = size;
    entry.sha512 = sha512;
    if (doc.path === entry.url) doc.sha512 = sha512;
    changed = true;
    console.log(`[sync-update-yml] Corrected ${entry.url}: size=${size} sha512=${sha512.slice(0, 12)}…`);
  }
}

if (changed) {
  fs.writeFileSync(ymlPath, yaml.dump(doc, { lineWidth: -1 }));
  console.log('[sync-update-yml] latest-mac.yml updated.');
} else {
  console.log('[sync-update-yml] latest-mac.yml already consistent.');
}
