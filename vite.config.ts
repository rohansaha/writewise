import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// ELECTRON=1 builds with relative asset paths so the bundle can be served
// from the app:// scheme inside Electron. The web build uses an absolute base
// so the service worker scope and manifest resolve correctly.
const isElectron = !!process.env.ELECTRON

export default defineConfig({
  base: isElectron ? './' : '/',
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null, // registered manually in src/pwa.ts (skipped inside Electron)
      disable: isElectron,
      includeAssets: ['icon.svg', 'dict/en-US.aff', 'dict/en-US.dic'],
      manifest: {
        name: 'WriteWise',
        short_name: 'WriteWise',
        description: 'Offline-first writing assistant: grammar, spelling, clarity and tone suggestions as you type.',
        theme_color: '#15c39a',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,aff,dic}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
})
