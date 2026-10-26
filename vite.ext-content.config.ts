import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Content script: must be a single classic script (no import/export).
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'extension-dist',
    emptyOutDir: false,
    target: 'es2022',
    minify: false,
    lib: { entry: resolve(import.meta.dirname, 'extension/src/content.ts'), formats: ['iife'], name: 'WriteWiseContent', fileName: () => 'content.js' },
  },
})
