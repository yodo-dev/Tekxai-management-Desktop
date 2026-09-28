#!/usr/bin/env node
/**
 * Post-build gate for Windows installers.
 *
 * Fails the release build if the Setup .exe is missing Authenticode, is not
 * signed by the expected TekXAI LLC internal certificate, or (when
 * osslsigncode is available) has a mismatched message digest.
 *
 * Public identity only — never reads PFX/password/private key material.
 *
 * Expected SHA1 thumbprint matches WINDOWS_CODE_SIGNING_DEPLOYMENT.md and
 * build/installer.nsh / install-tekxai-code-signing-cert.ps1.
 */
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXPECTED_THUMBPRINT = '4DAD471705AE5659F3E6ACE19F5C1160F35A39AB';
const EXPECTED_SUBJECT_SNIPPET = 'TekXAI LLC';

const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const pkg = require(path.join(rootDir, 'package.json'));

function fail(msg) {
  console.error(`[verify-win-sign] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[verify-win-sign] ${msg}`);
}

function findSetupExe(version) {
  if (!fs.existsSync(distDir)) fail(`dist/ not found at ${distDir}`);
  const versionEsc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^.*Setup.*${versionEsc}.*\\.exe$`, 'i');
  const match = fs.readdirSync(distDir).find((f) => re.test(f));
  if (!match) fail(`No "Setup ${version}.exe" found in dist/`);
  return path.join(distDir, match);
}

/** Read Authenticode certificate table from a PE file (file offset, not RVA). */
function readAuthenticodeTable(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(4096);
    fs.readSync(fd, header, 0, header.length, 0);
    if (header.toString('ascii', 0, 2) !== 'MZ') fail(`${path.basename(filePath)} is not a PE/MZ executable`);
    const e_lfanew = header.readUInt32LE(0x3c);
    const magic = header.readUInt16LE(e_lfanew + 24);
    let certDirOff;
    if (magic === 0x20b) certDirOff = e_lfanew + 24 + 144; // PE32+ DataDirectory[4]
    else if (magic === 0x10b) certDirOff = e_lfanew + 24 + 128; // PE32
    else fail(`Unknown optional-header magic 0x${magic.toString(16)}`);
    const certOff = header.readUInt32LE(certDirOff);
    const certSize = header.readUInt32LE(certDirOff + 4);
    if (!certOff || !certSize) return null;
    const table = Buffer.alloc(certSize);
    fs.readSync(fd, table, 0, certSize, certOff);
    return { certOff, certSize, table };
  } finally {
    fs.closeSync(fd);
  }
}

function extractPkcs7Der(table) {
  // WIN_CERTIFICATE: dwLength(4) + wRevision(2) + wCertificateType(2) + bCertificate
  const length = table.readUInt32LE(0);
  const revision = table.readUInt16LE(4);
  const certType = table.readUInt16LE(6);
  if (certType !== 2) fail(`Unexpected certificate type ${certType} (want 2 = PKCS#7)`);
  const der = table.subarray(8, Math.min(length, table.length));
  return { length, revision, certType, der };
}

function opensslCertPublicInfo(derPath) {
  // Subject / dates / fingerprint only — no private key involved.
  const out = execFileSync(
    'openssl',
    ['x509', '-inform', 'DER', '-in', derPath, '-noout', '-subject', '-issuer', '-dates', '-fingerprint', '-sha1'],
    { encoding: 'utf8' }
  );
  return out;
}

function parseThumbprint(opensslOut) {
  const m = opensslOut.match(/sha1\s+Fingerprint\s*=\s*([0-9A-Fa-f:]+)/i);
  if (!m) return null;
  return m[1].replace(/:/g, '').toUpperCase();
}

function hasOsslsigncode() {
  try {
    execSync('command -v osslsigncode', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function verifyWithOsslsigncode(exePath) {
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync('osslsigncode', ['verify', '-in', exePath], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    // Self-signed certs fail PKCS7 chain verify against system CAs — that is
    // expected for the TekXAI internal cert. Still require digest match +
    // signer identity in the output.
    stdout = `${e.stdout || ''}${e.stderr || ''}`;
    stderr = e.stderr || '';
    if (/No signature found/i.test(stdout) || /No signature found/i.test(stderr)) {
      fail('osslsigncode: No signature found');
    }
  }

  const combined = `${stdout}\n${stderr}`;
  if (!/Current message digest\s*:/i.test(combined) || !/Calculated message digest\s*:/i.test(combined)) {
    fail('osslsigncode did not report message digests');
  }
  const cur = combined.match(/Current message digest\s*:\s*([0-9A-Fa-f]+)/i);
  const calc = combined.match(/Calculated message digest\s*:\s*([0-9A-Fa-f]+)/i);
  if (!cur || !calc) fail('Could not parse message digests from osslsigncode');
  if (cur[1].toUpperCase() !== calc[1].toUpperCase()) {
    fail(`Message digest mismatch: current=${cur[1]} calculated=${calc[1]}`);
  }
  ok(`Message digest OK (${cur[1].toUpperCase()})`);

  if (!new RegExp(EXPECTED_SUBJECT_SNIPPET, 'i').test(combined)) {
    fail(`Signer subject does not contain "${EXPECTED_SUBJECT_SNIPPET}"`);
  }
  ok(`Signer subject contains "${EXPECTED_SUBJECT_SNIPPET}"`);

  const ts = combined.match(/Timestamp time:\s*(.+)/i);
  if (ts) ok(`Timestamp present: ${ts[1].trim()}`);
  else console.warn('[verify-win-sign] WARN: no authenticode timestamp found (signature still required)');

  return combined;
}

function main() {
  const version = pkg.version;
  const exePath = findSetupExe(version);
  ok(`Checking ${path.basename(exePath)} (v${version})`);

  const auth = readAuthenticodeTable(exePath);
  if (!auth) fail('Authenticode certificate table ABSENT — installer is unsigned');
  ok(`Authenticode table present (offset=${auth.certOff}, size=${auth.certSize})`);

  const { der } = extractPkcs7Der(auth.table);

  // Pull the leaf cert from the PKCS#7 blob via openssl pkcs7 -print_certs
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tekxai-win-sign-'));
  const p7Path = path.join(tmpDir, 'sig.p7');
  const leafPath = path.join(tmpDir, 'leaf.cer');
  try {
    fs.writeFileSync(p7Path, der);
    let certsPem;
    try {
      certsPem = execFileSync(
        'openssl',
        ['pkcs7', '-inform', 'DER', '-in', p7Path, '-print_certs', '-outform', 'PEM'],
        { encoding: 'utf8' }
      );
    } catch (e) {
      fail(`openssl could not parse Authenticode PKCS#7: ${e.message}`);
    }
    // First cert in the bag is the signer leaf for our builds.
    const blocks = certsPem.split(/-----END CERTIFICATE-----/).map((b) => b.trim()).filter(Boolean);
    if (!blocks.length) fail('No certificates found inside Authenticode PKCS#7');
    const leafPem = `${blocks[0]}\n-----END CERTIFICATE-----\n`;
    fs.writeFileSync(leafPath + '.pem', leafPem);
    execFileSync('openssl', ['x509', '-in', leafPath + '.pem', '-outform', 'DER', '-out', leafPath]);

    const info = opensslCertPublicInfo(leafPath);
    process.stdout.write(info);
    const thumb = parseThumbprint(info);
    if (!thumb) fail('Could not parse SHA1 thumbprint from signer certificate');
    if (thumb !== EXPECTED_THUMBPRINT) {
      fail(`Unexpected thumbprint ${thumb} (want ${EXPECTED_THUMBPRINT})`);
    }
    ok(`Thumbprint matches expected TekXAI LLC cert (${EXPECTED_THUMBPRINT})`);
    if (!new RegExp(EXPECTED_SUBJECT_SNIPPET, 'i').test(info)) {
      fail(`Certificate subject does not contain "${EXPECTED_SUBJECT_SNIPPET}"`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (hasOsslsigncode()) {
    verifyWithOsslsigncode(exePath);
  } else {
    console.warn('[verify-win-sign] WARN: osslsigncode not on PATH — skipped digest/timestamp check');
  }

  ok('PASS — Windows installer signature verified');
}

main();
