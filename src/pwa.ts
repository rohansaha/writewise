// Registers the service worker for the web build so the app installs and works
// offline. Skipped inside Electron (app:// scheme) and in dev.
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  if (!/^https?:$/.test(location.protocol)) return
  if (import.meta.env.DEV) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((err) => console.warn('Service worker registration failed', err))
  })
}
