// Assembles docs-addon/dist/ for `clasp push`:
//   Sidebar.html   = docs-addon/src/Sidebar.html + inlined engine bundle + inlined Hunspell dictionary
//   Code.js        = docs-addon/src/Code.js (unchanged)
//   appsscript.json= docs-addon/appsscript.json (unchanged)
// Run after `vite build --config vite.docs-addon.config.ts` (npm run build:docs-addon does both).
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const addon = path.join(root, 'docs-addon')
const dist = path.join(addon, 'dist')
const enginePath = path.join(addon, 'build', 'engine.js')

if (!existsSync(enginePath)) {
  console.error(`missing ${path.relative(root, enginePath)}; run: vite build --config vite.docs-addon.config.ts`)
  process.exit(1)
}

const engine = readFileSync(enginePath, 'utf8')
const aff = readFileSync(path.join(root, 'public', 'dict', 'en-US.aff'), 'utf8')
const dic = readFileSync(path.join(root, 'public', 'dict', 'en-US.dic'), 'utf8')
const template = readFileSync(path.join(addon, 'src', 'Sidebar.html'), 'utf8')

// Inside an inline <script> the HTML parser ends the element at "</script" and treats "<!--"
// specially. Both escapes are no-ops for JavaScript (in strings, regexes and template literals).
const scriptSafe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
const jsString = (s) => scriptSafe(JSON.stringify(s))

for (const marker of ['/*__ENGINE__*/', '"__AFF__"', '"__DIC__"']) {
  if (!template.includes(marker)) { console.error(`template is missing the ${marker} marker`); process.exit(1) }
}

const html = template
  .replace('/*__ENGINE__*/', () => scriptSafe(engine))
  .replace('"__AFF__"', () => jsString(aff))
  .replace('"__DIC__"', () => jsString(dic))

mkdirSync(dist, { recursive: true })
writeFileSync(path.join(dist, 'Sidebar.html'), html)
copyFileSync(path.join(addon, 'src', 'Code.js'), path.join(dist, 'Code.js'))
copyFileSync(path.join(addon, 'appsscript.json'), path.join(dist, 'appsscript.json'))

const kb = (p) => (statSync(p).size / 1024).toFixed(0) + ' KB'
for (const f of ['Sidebar.html', 'Code.js', 'appsscript.json']) console.log(`docs-addon/dist/${f}  ${kb(path.join(dist, f))}`)
console.log(`(engine ${kb(enginePath)}, dictionary ${((aff.length + dic.length) / 1024).toFixed(0)} KB)`)
