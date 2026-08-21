const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Runs as a separate step *after* electron-builder fully exits (same
// reasoning as scripts/sync-update-yml.js: for mac, stapling rewrites the
// .dmg in place after electron-builder has already produced the artifact,
// so any checksum computed before that point would be wrong for the file
// that actually ships). package.json wires this in after sync-update-yml.js
// on build:mac, and directly after electron-builder on build:win/build:linux
// (no stapling step there, so no ordering constraint, but running it the
// same way on every platform keeps this script's behavior uniform).
//
// This exists because nothing in this repo ever generated metadata.json
// before — the backend's /downloads/latest legacy fallback path read it
// from a fixed EC2 path, but no build step here ever wrote it, so it was
// either hand-edited once and abandoned, or never created at all. That's
// the root cause of the version/checksum drift this script closes: version,
// installer filenames, and SHA256 hashes below are all read from the
// *actual* dist/ artifacts this build just produced — never hand-typed,
// never carried over from a previous release.
//
// Per the existing platform-split convention (RELEASE_PROCESS.md): macOS is
// built on one machine, Windows on another. Each machine's build only ever
// has its own platform's artifacts in dist/, so this script only reports on
// what actually exists in dist/ on the machine it runs on — never invents
// entries for platforms it can't see. Uploading this alongside that
// machine's own installer artifacts (to the same metadata.json location the
// backend's fallback reads from) is still a manual step, same as uploading
// the installers themselves already is in this pipeline — this script's job
// is only to make sure what gets uploaded is never stale or hand-typed.

const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const pkg = require(path.join(rootDir, 'package.json'));

function sha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function git(cmd, fallback = null) {
  try {
    return execSync(`git ${cmd}`, { cwd: rootDir, encoding: 'utf8' }).trim() || fallback;
  } catch {
    return fallback;
  }
}

// electron-builder names artifacts "<productName>-<version>[-arch].<ext>" —
// find whatever this machine's dist/ actually contains for this exact
// version, rather than assuming a fixed filename pattern that could drift
// from what electron-builder actually produced (e.g. a config change to
// `artifactName`).
function find_artifact(patterns) {
  if (!fs.existsSync(distDir)) return null;
  const files = fs.readdirSync(distDir);
  for (const pattern of patterns) {
    const match = files.find((f) => pattern.test(f));
    if (match) return match;
  }
  return null;
}

const version = pkg.version;
const versionEsc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const winFile   = find_artifact([new RegExp(`^.*Setup.*${versionEsc}.*\\.exe$`, 'i'), new RegExp(`^.*${versionEsc}.*\\.exe$`, 'i')]);
const macFile   = find_artifact([new RegExp(`^.*${versionEsc}-universal\\.dmg$`, 'i'), new RegExp(`^.*${versionEsc}.*\\.dmg$`, 'i')]);
const linuxFile = find_artifact([new RegExp(`^.*${versionEsc}\\.AppImage$`, 'i')]);
const linuxArmFile = find_artifact([new RegExp(`^.*${versionEsc}-arm64\\.AppImage$`, 'i')]);

const checksums = {
  windows:    winFile      ? sha256(path.join(distDir, winFile))      : null,
  mac:        macFile      ? sha256(path.join(distDir, macFile))      : null,
  linux:      linuxFile    ? sha256(path.join(distDir, linuxFile))    : null,
  linuxArm64: linuxArmFile ? sha256(path.join(distDir, linuxArmFile)) : null,
};

const metadata = {
  version,
  buildDate: new Date().toISOString(),
  commit: git('rev-parse HEAD'),
  branch: git('branch --show-current'),
  author: git('log -1 --pretty=%an'),
  commitMessage: git('log -1 --pretty=%s'),
  platforms: [winFile && 'windows', macFile && 'mac', linuxFile && 'linux'].filter(Boolean),
  windowsAvailable: !!winFile,
  windowsFilename: winFile || null,
  macFilename: macFile || null,
  linuxFilename: linuxFile || null,
  linuxArm64Filename: linuxArmFile || null,
  checksums,
};

if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
const outPath = path.join(distDir, 'metadata.json');
fs.writeFileSync(outPath, JSON.stringify(metadata, null, 2) + '\n');

console.log(`[generate-metadata] Wrote ${outPath}`);
console.log(`[generate-metadata]   version: ${version}`);
console.log(`[generate-metadata]   windows: ${winFile || '(not built on this machine)'}`);
console.log(`[generate-metadata]   mac:     ${macFile || '(not built on this machine)'}`);
console.log(`[generate-metadata]   linux:   ${linuxFile || '(not built on this machine)'}${linuxArmFile ? ` / ${linuxArmFile}` : ''}`);
if (!winFile && !macFile && !linuxFile) {
  console.warn('[generate-metadata] WARNING: no installer artifacts found in dist/ matching this package.json version — metadata.json was written with all fields null. Did the build actually produce artifacts for this version?');
}
