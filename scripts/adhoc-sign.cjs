// macOS signing for builds without an Apple Developer certificate.
//
// With ILF_MAC_SIGN_ID set (a self-signed "iloveframes" code-signing identity imported
// in CI, see .github/workflows/build-mac.yml), every build is signed by the same key, so
// its designated requirement stays the same across versions and macOS keeps the user's
// Screen Recording / Camera / Microphone permissions through updates.
// Without it the bundle is ad-hoc signed (Apple Silicon needs a signature to launch);
// macOS then treats every update as a new app and asks for permissions again.
const { execFileSync } = require('child_process')
const path = require('path')
exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'darwin') return
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`)
  const id = process.env.ILF_MAC_SIGN_ID
  const keychain = process.env.ILF_MAC_KEYCHAIN
  const args = ['--force', '--deep', '--sign', id || '-', '--identifier', 'com.iloveframes.app']
  if (id && keychain) args.push('--keychain', keychain)
  execFileSync('codesign', [...args, app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' })
  console.log(`  • ${id ? 'signed with the iloveframes identity' : 'ad-hoc signed'}: ${path.basename(app)}`)
}
