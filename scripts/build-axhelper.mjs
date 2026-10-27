// Compiles the macOS Accessibility helper (native/axhelper.swift) into a universal binary at
// native/build/axhelper. electron-builder copies it into the app bundle's Resources folder.
// On other platforms, or without the Xcode Command Line Tools, it is skipped: the app then falls
// back to the clipboard hotkeys and has no overlay.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
if (process.platform !== 'darwin') { console.log('build-axhelper: not macOS, skipping'); process.exit(0) }
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
