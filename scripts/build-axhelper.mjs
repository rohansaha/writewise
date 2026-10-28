// Compiles the accessibility helper that lets WriteWise read and edit text boxes in other apps.
// macOS: native/axhelper.swift -> a universal binary at native/build/axhelper (needs the Xcode
// Command Line Tools). Windows: native/axhelper-win.cs -> native/build/axhelper.exe, compiled with the
// C# compiler that ships with the .NET Framework, so no SDK is needed. electron-builder copies the
// result into the app's resources. Elsewhere, or without a compiler, it is skipped: the app then falls
// back to the clipboard hotkeys and has no overlay.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
if (process.platform === 'win32') buildWindows()
if (process.platform !== 'darwin') { console.log('build-axhelper: not macOS or Windows, skipping'); process.exit(0) }
const src = path.join(root, 'native', 'axhelper.swift')
const out = path.join(root, 'native', 'build')
mkdirSync(out, { recursive: true })
let swiftc
try { swiftc = execFileSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).trim() } catch {
  console.warn('build-axhelper: swiftc not found (install the Xcode Command Line Tools); in-place hotkeys and the overlay will be unavailable')
  process.exit(0)
}
const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim()
const slices = []
for (const [arch, target] of [['arm64', 'arm64-apple-macos12.0'], ['x64', 'x86_64-apple-macos14.0']]) {
  const bin = path.join(out, `axhelper-${arch}`)
  try { execFileSync(swiftc, ['-O', '-sdk', sdk, '-target', target, src, '-o', bin], { stdio: 'inherit' }); slices.push(bin) } catch { console.warn(`build-axhelper: ${arch} slice failed`) }
}
if (!slices.length) process.exit(1)
const final = path.join(out, 'axhelper')
if (slices.length > 1) execFileSync('lipo', ['-create', ...slices, '-output', final], { stdio: 'inherit' })
else execFileSync('cp', [slices[0], final])
console.log('build-axhelper: wrote', path.relative(root, final), `(${slices.length} slice${slices.length === 1 ? '' : 's'})`)

function buildWindows() {
  const windir = process.env.WINDIR || 'C:\\Windows'
  const frameworks = ['Framework64', 'Framework'].map((f) => path.join(windir, 'Microsoft.NET', f, 'v4.0.30319'))
  const csc = frameworks.map((d) => path.join(d, 'csc.exe')).find(existsSync)
  if (!csc) {
    console.warn('build-axhelper: csc.exe from the .NET Framework 4 was not found; in-place hotkeys and the overlay will be unavailable')
    process.exit(0)
  }
  // UI Automation lives in the WPF folder of the framework; the reference assemblies are a fallback.
  const refDirs = [
    ...frameworks.flatMap((d) => [path.join(d, 'WPF'), d]),
    ...['v4.8.1', 'v4.8', 'v4.7.2'].map((v) => path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Reference Assemblies', 'Microsoft', 'Framework', '.NETFramework', v)),
  ]
  const refs = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll', 'System.Web.Extensions.dll'].map((dll) => {
    const found = refDirs.map((d) => path.join(d, dll)).find(existsSync)
    if (!found) { console.warn(`build-axhelper: ${dll} not found; in-place hotkeys and the overlay will be unavailable`); process.exit(0) }
    return found
  })
  const out = path.join(root, 'native', 'build')
  mkdirSync(out, { recursive: true })
  const exe = path.join(out, 'axhelper.exe')
  // AnyCPU runs natively on x64 and on ARM64 Windows 11 (through the framework's own ARM64 support or emulation).
  execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${exe}`, ...refs.map((r) => `/reference:${r}`), path.join(root, 'native', 'axhelper-win.cs')], { stdio: 'inherit' })
  console.log('build-axhelper: wrote', path.relative(root, exe))
  process.exit(0)
}
