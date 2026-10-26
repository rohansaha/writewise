import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Google Docs add-on: bundles the engine into one classic script that the sidebar
// HTML inlines (HtmlService pages cannot load local files). scripts/build-docs-addon.mjs
// then stitches it, the dictionary and the Apps Script sources into docs-addon/dist/.
export default defineConfig({
  publicDir: false,
  // pluralize is UMD and would miss `require` inside an IIFE bundle; see docs-addon/src/pluralize-shim.js.
  resolve: { alias: [{ find: /^pluralize$/, replacement: resolve(import.meta.dirname, 'docs-addon/src/pluralize-shim.js') }] },
  build: {
    outDir: 'docs-addon/build',
    emptyOutDir: true,
    target: 'es2020',
    minify: true,
    sourcemap: false,
    reportCompressedSize: false,
    lib: { entry: resolve(import.meta.dirname, 'docs-addon/src/engine.ts'), formats: ['iife'], name: 'WriteWiseEngine', fileName: () => 'engine.js' },
  },
})
