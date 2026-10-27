// electron-builder afterPack hook (macOS). Signs the packed app with the local "WriteWise Local Signing"
// identity when it exists in the login keychain, so the app's code identity, and with it the macOS
// permission grants it depends on (Accessibility), stays the same from one build to the next.
// Without that identity the app is left as electron-builder made it (ad-hoc signed), which works but
// gets a new identity on every rebuild; README > Build the desktop app explains the one-time setup.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const IDENTITY = process.env.WRITEWISE_SIGN_IDENTITY || 'WriteWise Local Signing'
const helperPath = (appPath) => path.join(appPath, 'Contents', 'Resources', 'axhelper')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  let identities = ''
  try { identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }) } catch { identities = '' }
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!identities.includes(`"${IDENTITY}"`)) {
    // Same as electron-builder's default: an ad-hoc signature, which Apple silicon needs to launch the app.
    console.log(`  • sign-mac: no "${IDENTITY}" identity in the keychain; ad-hoc signing instead (each rebuild will need the Accessibility grant redone)`)
    execFileSync('codesign', ['--force', '--sign', '-', helperPath(appPath)], { stdio: 'inherit' })
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
    return
  }
  console.log(`  • sign-mac: signing ${path.basename(appPath)} with "${IDENTITY}"`)
  // The Accessibility helper lives in Resources, which --deep seals as data rather than code: sign it first
  // so it carries the same stable identity and both of its architecture slices are signed.
  execFileSync('codesign', ['--force', '--sign', IDENTITY, '--timestamp=none', helperPath(appPath)], { stdio: 'inherit' })
  execFileSync('codesign', ['--force', '--deep', '--sign', IDENTITY, '--timestamp=none', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  const requirement = execFileSync('codesign', ['-d', '-r-', appPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(`  • sign-mac: designated requirement ${requirement.trim().split('\n').pop()}`)
}
