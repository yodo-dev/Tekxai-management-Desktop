// Moved out of package.json's "build" field specifically to make Windows
// code signing conditional (Azure Trusted Signing vs. a standard/EV local
// certificate vs. unsigned) — package.json's static JSON can't express "use
// this signing config only if these env vars are actually set" without
// either always attempting to sign (breaking today's working unsigned build
// the moment this file exists but no certificate does) or always skipping
// (never actually usable once a certificate is provisioned). A JS config
// file is electron-builder's own supported mechanism for exactly this kind
// of conditional logic — not a workaround, the standard pattern for
// non-trivial signing setups. Every field below except `win` is unchanged
// from what package.json's `build` object contained before this migration.

function resolveWinSigning() {
  // 1. Azure Trusted Signing — electron-builder's built-in support (no
  //    custom script needed), used when the three account-identifying env
  //    vars are present. See docs/CODE_SIGNING.md for what these values are
  //    and where they come from (an Azure Trusted Signing resource).
  if (process.env.AZURE_SIGNING_ENDPOINT && process.env.AZURE_SIGNING_ACCOUNT && process.env.AZURE_SIGNING_PROFILE) {
    console.log('[build] Windows: signing via Azure Trusted Signing.');
    return {
      azureSignOptions: {
        publisherName: 'Tekxai LLC',
        endpoint: process.env.AZURE_SIGNING_ENDPOINT,
        codeSigningAccountName: process.env.AZURE_SIGNING_ACCOUNT,
        certificateProfileName: process.env.AZURE_SIGNING_PROFILE,
      },
    };
  }

  // 2. Standard or EV certificate as a local file (PFX/P12) — this needs NO
  //    explicit config at all. electron-builder automatically signs with
  //    whatever WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD (falling back to
  //    CSC_LINK/CSC_KEY_PASSWORD) resolve to, purely from the environment,
  //    the moment those env vars exist on the build machine. Nothing to add
  //    here — this branch exists only to document that the "do nothing"
  //    case is itself the supported path, not an oversight.
  if (process.env.WIN_CSC_LINK || process.env.CSC_LINK) {
    console.log('[build] Windows: signing via CSC_LINK/WIN_CSC_LINK (local certificate file) — handled automatically by electron-builder.');
    return {};
  }

  // 3. A certificate already installed in the build machine's certificate
  //    store (common for an EV cert on a hardware token/cloud HSM accessed
  //    via a Windows cert-store provider) — identify it by subject name or
  //    SHA1 thumbprint rather than a file path.
  if (process.env.WIN_CERT_SUBJECT_NAME) {
    console.log('[build] Windows: signing via certificate store (subject name).');
    return { certificateSubjectName: process.env.WIN_CERT_SUBJECT_NAME };
  }
  if (process.env.WIN_CERT_SHA1) {
    console.log('[build] Windows: signing via certificate store (SHA1 thumbprint).');
    return { certificateSha1: process.env.WIN_CERT_SHA1 };
  }

  // Nothing configured — build proceeds unsigned, same as today. Warn
  // loudly rather than fail silently, mirroring scripts/notarize.js's own
  // "skip with a warning" pattern for the equivalent macOS gap.
  console.warn(
    '[build] No Windows code-signing configured (AZURE_SIGNING_*, WIN_CSC_LINK/CSC_LINK, or ' +
    'WIN_CERT_SUBJECT_NAME/WIN_CERT_SHA1 env vars not set) — this Windows build will be UNSIGNED. ' +
    'See docs/CODE_SIGNING.md before a real company-wide release.'
  );
  return {};
}

module.exports = {
  appId: 'com.tekxaierp.app',
  productName: 'TEKxAI Agent',
  icon: 'assets/icon',
  files: [
    'src/**/*',
    'assets/**/*',
    '!**/build-tmp-napi-v6/**',
    '!**/*.{o,obj,Makefile}',
  ],
  // screenshot-desktop's Windows capture path (lib/win32/index.js's
  // copyToTemp()) reads its bundled screenCapture_*.bat/app.manifest via
  // `__dirname` with a literal `.replace('app.asar', 'app.asar.unpacked')`
  // — it does NOT read them from inside the asar archive, it requires them
  // to already exist as real files on disk next to it. Electron-builder's
  // automatic asar-unpack heuristic only catches native `.node` binaries
  // (which is why active-win's native module was never affected) — a
  // plain `.bat` file is invisible to that heuristic, so without this
  // explicit rule the file is sealed inside asar and every single Windows
  // install hits `ENOENT ... app.asar.unpacked\...\screenCapture_1.3.2.bat`
  // the moment it tries to capture a screenshot (100% reproducible, not
  // per-machine — confirmed by tracing the exact resolution logic, not by
  // guessing at AV/corruption). macOS/Linux capture paths shell out to the
  // OS's own screencapture/import binaries and need no bundled file at
  // all, so this is Windows-only.
  asarUnpack: [
    'node_modules/screenshot-desktop/**/*',
  ],
  publish: {
    provider: 'generic',
    url: 'https://releases.tekxai.services/desktop-app',
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon.ico',
    ...resolveWinSigning(),
  },
  mac: {
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] },
    ],
    icon: 'assets/icon.icns',
    category: 'public.app-category.productivity',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    identity: 'Tekxai LLC (64GRQF7C5Z)',
    notarize: false,
  },
  afterSign: 'scripts/notarize.js',
  afterAllArtifactBuild: 'scripts/staple-dmg.js',
  linux: {
    // deb dropped — building it on a macOS host produces a corrupt package
    // (confirmed: `file` identifies the output as a macOS ar/ranlib static-
    // library stub, not a real .deb — dpkg-deb-based packaging doesn't
    // cross-build correctly from macOS). AppImage is a real, working
    // cross-build target and needs no host-specific packaging tool, so it
    // stays as the only Linux target until deb building has an actual
    // Linux host/CI runner behind it.
    target: [
      { target: 'AppImage', arch: ['x64', 'arm64'] },
    ],
    icon: 'assets/icon.png',
    category: 'Utility',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    // Custom NSIS include (see build/installer.nsh) that detects a running
    // "TEKxAI Agent.exe" and closes it (gracefully, then forcibly if
    // needed) before install proceeds. This replaces the invalid
    // closeApplication/restartApplication keys attempted in 9c4fc68 and
    // reverted in 0320daf — those are not real electron-builder NSIS
    // options at any version, including current latest. `include` is
    // electron-builder's actual supported mechanism for this.
    include: 'build/installer.nsh',
  },
};
