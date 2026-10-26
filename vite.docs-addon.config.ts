import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Google Docs add-on: bundles the engine into one classic script that the sidebar
// HTML inlines (HtmlService pages cannot load local files). scripts/build-docs-addon.mjs
// then stitches it, the dictionary and the Apps Script sources into docs-addon/dist/.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'docs-addon/build',
    emptyOutDir: true,
    target: 'es2020',
    minify: 'esbuild',
    sourcemap: false,
    reportCompressedSize: false,
    lib: { entry: resolve(import.meta.dirname, 'docs-addon/src/engine.ts'), formats: ['iife'], name: 'WriteWiseEngine', fileName: () => 'engine.js' },
  },
})
