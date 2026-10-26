import { defineConfig } from 'vite'

// Bundles the CLI / hook / MCP server / Electron-side engine into one Node file.
export default defineConfig({
  build: {
    ssr: 'cli/index.ts',
    outDir: 'bin',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: 'writewise.mjs', format: 'es', inlineDynamicImports: true } },
  },
  ssr: { noExternal: true, target: 'node' },
})
