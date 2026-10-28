// Updates from GitHub Releases (electron-updater reads app-update.yml, generated from package.json
// build.publish, and the latest*.yml files the release workflow attaches to every release).
//
// Windows installer and Linux AppImage: the new version downloads in the background and installs the
// next time WriteWise quits. macOS: installing an update needs an Apple Developer ID signature, which
// these builds do not have, so the app only says a new version is out and links to the release.
// The Windows portable exe and development runs never update themselves.
const { app, dialog, shell } = require('electron')

const RELEASES_URL = 'https://github.com/rohansaha/writewise/releases/latest'
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

function canInstall() {
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_DIR
  if (process.platform === 'linux') return !!process.env.APPIMAGE
  return false
}

function supported() {
  return app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR && (process.platform === 'darwin' || canInstall())
}

function createUpdater({ notify }) {
  let autoUpdater = null
  let downloaded = null   // version waiting to be installed on quit
  let announced = null    // version already announced (macOS), so each one is announced once
  let manual = false      // the current check came from the menu: report every outcome in a dialog

  function load() {
    if (autoUpdater || !supported()) return autoUpdater
    try { ({ autoUpdater } = require('electron-updater')) } catch (err) { console.warn('[updater] unavailable:', err.message); return null }
    autoUpdater.autoDownload = canInstall()
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null
    autoUpdater.on('error', (err) => {
      console.warn('[updater]', err && err.message)
      if (manual) { manual = false; dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates', detail: (err && err.message) || String(err) }) }
    })
    autoUpdater.on('update-not-available', () => {
      if (manual) { manual = false; dialog.showMessageBox({ type: 'info', message: 'WriteWise is up to date', detail: `You have version ${app.getVersion()}.` }) }
    })
    autoUpdater.on('update-available', (info) => {
      if (canInstall()) {
        if (manual) { manual = false; notify('WriteWise', `Downloading version ${info.version}…`) }
        return
      }
      if (announced === info.version && !manual) return
      announced = info.version
      manual = false
      dialog.showMessageBox({ type: 'info', message: `WriteWise ${info.version} is available`, detail: `You have version ${app.getVersion()}. Download the new installer from GitHub and open it to update.`, buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1 })
        .then(({ response }) => { if (response === 0) shell.openExternal(RELEASES_URL) })
    })
    autoUpdater.on('update-downloaded', (info) => {
      if (downloaded === info.version) return
      downloaded = info.version
      notify('WriteWise update ready', `Version ${info.version} installs when you quit WriteWise. Choose Help → Check for updates to install it now.`)
    })
    return autoUpdater
  }

  function check() {
    const u = load()
    if (!u) return
    u.checkForUpdates().catch((err) => console.warn('[updater] check failed:', err && err.message))
  }

  /** Help → Check for updates: like the background check, but every outcome is reported. */
  function checkNow() {
    if (!supported()) {
      return dialog.showMessageBox({ type: 'info', message: 'Updates are not automatic for this copy', detail: `You have version ${app.getVersion()}. Get the latest installer from GitHub.`, buttons: ['Open releases', 'OK'], defaultId: 0, cancelId: 1 })
        .then(({ response }) => { if (response === 0) shell.openExternal(RELEASES_URL) })
    }
    if (downloaded) return restartToUpdate()
    manual = true
    check()
  }

  function restartToUpdate() {
    const u = load()
    if (u && downloaded) u.quitAndInstall()
  }

  function start() {
    if (!supported()) return
    setTimeout(check, 15 * 1000) // after launch work has settled
    setInterval(check, CHECK_EVERY_MS)
  }

  return { start, checkNow, restartToUpdate, hasUpdate: () => !!downloaded }
}

module.exports = { createUpdater }
