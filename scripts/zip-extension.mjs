// Zips extension-dist/ into release/writewise-chrome-extension-<version>.zip for the Chrome Web Store.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
mkdirSync(path.join(root, 'release'), { recursive: true })
const out = path.join(root, 'release', `writewise-chrome-extension-${version}.zip`)
rmSync(out, { force: true })
const r = spawnSync('zip', ['-r', '-X', out, '.'], { cwd: path.join(root, 'extension-dist'), stdio: 'inherit' })
if (r.status !== 0) { console.error('zip failed (on Windows, zip the extension-dist folder manually)'); process.exit(1) }
console.log('wrote', out)
