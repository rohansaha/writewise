// Rasterizes public/icon.svg into the PNG sizes needed by the PWA manifest and
// electron-builder (which converts build/icon.png into .icns/.ico itself).
import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const svg = path.join(root, 'public', 'icon.svg')
await mkdir(path.join(root, 'public', 'icons'), { recursive: true })
await mkdir(path.join(root, 'build'), { recursive: true })

await mkdir(path.join(root, 'extension', 'public', 'icons'), { recursive: true })
const targets = [
  [16, 'extension/public/icons/icon-16.png'],
  [32, 'extension/public/icons/icon-32.png'],
  [48, 'extension/public/icons/icon-48.png'],
  [128, 'extension/public/icons/icon-128.png'],
  [192, 'public/icons/icon-192.png'],
  [512, 'public/icons/icon-512.png'],
  [1024, 'build/icon.png'],
]
for (const [size, out] of targets) {
  await sharp(svg, { density: 300 }).resize(size, size).png().toFile(path.join(root, out))
  console.log('wrote', out)
}
// Maskable icon: the artwork padded to the safe zone (80% of the canvas).
const inner = Math.round(512 * 0.8)
const art = await sharp(svg, { density: 300 }).resize(inner, inner).png().toBuffer()
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#0d9c7a' } })
  .composite([{ input: art, gravity: 'centre' }])
  .png()
  .toFile(path.join(root, 'public/icons/maskable-512.png'))
console.log('wrote public/icons/maskable-512.png')
