import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Background service worker + popup (ES modules). The content script is built separately (IIFE).
export default defineConfig({
  root: 'extension',
  publicDir: 'public',
  build: {
    outDir: '../extension-dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    rollupOptions: {
      input: { background: resolve(import.meta.dirname, 'extension/src/background.ts'), popup: resolve(import.meta.dirname, 'extension/popup.html') },
      output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name].js', assetFileNames: 'assets/[name][extname]', format: 'es' },
    },
  },
})
