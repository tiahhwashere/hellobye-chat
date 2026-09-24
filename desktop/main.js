// HelloBye Desktop — a native Electron app for HelloBye Chat.
//
// Design goals (this build):
//  - Feel like a real PC application, not a website embedded in a window.
//    The window is frameless. There is NO full-width title bar: preload.js
//    pins a small minimise / maximise / close cluster to the top-right (aligned
//    with the website's own header row) and makes the app's top header row
//    draggable, so the whole window moves when you drag the top of the app.
//  - Open at 60% of the screen by default, and render the app content zoomed
//    out to ~60% so the original layout doesn't look smushed in a small window.
//  - No File / View / Edit / Help menu bar at all.
//  - Show a custom CSS-only launch splash (no emojis / no SVG icons) every
//    time the app is opened, before the app content appears.
//  - "Soft update": poll the site's /api/version endpoint. When the deployed
//    build id changes, show a soft in-app toast. Applying the update RESTARTS
//    the whole client (relaunch) so the new build is loaded cleanly — no page
//    refresh, and the login/data are kept (persistent partition).
//  - Microphone/camera permissions are granted automatically so voice works.

const { app, BrowserWindow, shell, session, Menu, dialog, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

// The live site. Override with HELLOBYE_URL for local testing.
const APP_URL = process.env.HELLOBYE_URL || 'https://hellobye-chat.onrender.com/';
const VERSION_URL = new URL('/api/version', APP_URL).toString();
const POLL_INTERVAL_MS = 30 * 1000; // check for updates every 30s

// Render the app content zoomed out so the original (100%) layout, which is
// designed for a full browser window, doesn't look cramped in the smaller
// desktop window. 0.6 == 60%.
const DEFAULT_ZOOM = 0.6;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.5;
const ZOOM_STEP = 0.1;

// How long the launch splash stays up at minimum, so the animation is seen.
const SPLASH_MIN_MS = 1700;

let mainWindow = null;
let splashWindow = null;
let updateTimer = null;
let knownBuildId = null;
let updatePending = false;

// Native app identity (Windows taskbar grouping / notifications).
app.setName('Hellobye');
if (process.platform === 'win32') app.setAppUserModelId('com.hellobye.chat');

// ---- Persistent state (remembers the last build id we ran) ----
function statePath() { return path.join(app.getPath('userData'), 'desktop-state.json'); }
function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { return {}; }
}
function writeState(patch) {
  try {
    const s = Object.assign(readState(), patch);
    fs.writeFileSync(statePath(), JSON.stringify(s, null, 2));
  } catch (e) { /* non-fatal */ }
}

// ---- Launch splash (custom CSS-only loading animation) ----
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 440,
    frame: false,
    resizable: false,
    movable: true,
    show: false,
    center: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#101116',
    title: 'Hellobye',
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });
  splashWindow.on('closed', () => { splashWindow = null; });
}

// Fade the splash out, then close it and reveal the main window.
function revealApp() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents
      .executeJavaScript("document.documentElement.classList.add('hb-splash-hide')")
      .catch(() => {});
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      splashWindow = null;
    }, 420);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

// Wait for both the minimum splash time AND the app page to finish loading,
// then reveal the app.
function revealWhenReady() {
  const minSplash = new Promise((r) => setTimeout(r, SPLASH_MIN_MS));
  const loaded = new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve();
    const wc = mainWindow.webContents;
    if (!wc.isLoading()) return resolve();
    wc.once('did-finish-load', () => resolve());
    // Safety net: never hang on the splash if the page is slow.
    setTimeout(resolve, 12000);
  });
  Promise.all([minSplash, loaded]).then(revealApp);
}

// ---- Window ----
function createWindow() {
  // Default size: 60% of the primary display's usable area.
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.max(860, Math.round(screenW * 0.6));
  const height = Math.max(540, Math.round(screenH * 0.6));

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 860,
    minHeight: 540,
    backgroundColor: '#1a1b1e',
    title: 'Hellobye',
    // Frameless: the app draws its own native title bar (see preload.js).
    frame: false,
    // No native menu bar anywhere.
    autoHideMenuBar: true,
    // Keep the window hidden until the splash finishes.
    show: false,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A fixed partition keeps the login session across app restarts.
      partition: 'persist:hellobye',
      backgroundThrottling: false,
      spellcheck: false,
      // Let the preload know the zoom factor so it can keep the native title
      // bar at its true pixel size while the page content is zoomed out.
      additionalArguments: ['--hb-zoom=' + DEFAULT_ZOOM],
    },
  });

  // Restore the window mode the user last closed the app in (full screen or
  // restored/maximised). This is saved automatically on close and on every
  // mode change, so it is always up to date.
  const savedWin = readState().window || {};
  if (savedWin.fullScreen) {
    try { mainWindow.setFullScreen(true); } catch (e) {}
  } else if (savedWin.maximized) {
    try { mainWindow.maximize(); } catch (e) {}
  }

  // Zoom the app content out to ~60% so the original layout isn't smushed.
  applyZoom(DEFAULT_ZOOM, false);

  mainWindow.loadURL(APP_URL);

  // Re-assert the zoom once the page has loaded (zoom can reset on navigation).
  mainWindow.webContents.on('did-finish-load', () => applyZoom(currentZoom, false));

  // Keep the renderer's maximise/restore icon in sync, and remember the window
  // mode so it can be restored on the next launch.
  mainWindow.on('maximize', () => { sendToRenderer('window-maximized', true); captureWindowState(); });
  mainWindow.on('unmaximize', () => { sendToRenderer('window-maximized', false); captureWindowState(); });
  mainWindow.on('enter-full-screen', () => { sendToRenderer('window-maximized', true); captureWindowState(); });
  mainWindow.on('leave-full-screen', () => { sendToRenderer('window-maximized', false); captureWindowState(); });
  // Persist the exact mode at the moment the user closes the app.
  mainWindow.on('close', captureWindowState);

  // Open external links (http/https not on our origin) in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(APP_URL) || url.startsWith('https://hellobye-chat.onrender.com')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_URL) && !url.startsWith('https://hellobye-chat.onrender.com')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Native-app keyboard shortcuts (there is no menu to provide them).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (input.key === 'F11') { event.preventDefault(); toggleFullScreen(); return; }
    if (ctrl && (input.key === '+' || input.key === '=')) { event.preventDefault(); zoomBy(ZOOM_STEP); return; }
    if (ctrl && input.key === '-') { event.preventDefault(); zoomBy(-ZOOM_STEP); return; }
    if (ctrl && input.key === '0') { event.preventDefault(); applyZoom(DEFAULT_ZOOM, true); return; }
    // DevTools only in development (never in a packaged build).
    if (ctrl && input.shift && (input.key === 'I' || input.key === 'i') && !app.isPackaged) {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// Remember whether the window was in full screen or restored (maximised /
// normal) so the exact same mode is restored on the next launch. Saved
// automatically whenever the mode changes and when the user closes the app.
function captureWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    writeState({
      window: {
        fullScreen: mainWindow.isFullScreen(),
        maximized: mainWindow.isMaximized(),
      },
    });
  } catch (e) { /* non-fatal */ }
}

function iconPath() {
  const ico = path.join(__dirname, 'assets', 'icon.ico');
  const png = path.join(__dirname, 'assets', 'icon.png');
  if (process.platform === 'win32' && fs.existsSync(ico)) return ico;
  if (fs.existsSync(png)) return png;
  return undefined;
}

// ---- Window controls (driven by the custom title bar) ----
function toggleFullScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
}

let currentZoom = DEFAULT_ZOOM;
function zoomBy(delta) {
  applyZoom(currentZoom + delta, true);
}
function applyZoom(factor, notify) {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(factor * 100) / 100));
  currentZoom = clamped;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setZoomFactor(clamped);
  }
  if (notify) sendToRenderer('zoom-changed', clamped);
}

// ---- Permissions: auto-grant mic/camera so voice chat just works ----
function configurePermissions() {
  const ses = session.fromPartition('persist:hellobye');
  const allowed = new Set(['media', 'audioCapture', 'videoCapture', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission) => allowed.has(permission));
}

// ---- Screen sharing ----
// Electron REQUIRES a display-media request handler. Without one,
// navigator.mediaDevices.getDisplayMedia() rejects and the site shows
// "Could not start screen share. Please try again." Here we gather the
// available screens + windows and let the user pick one through an in-app
// picker (rendered by preload.js). The chosen source is handed back to the
// page, so the screen share starts and every other user in the call receives
// the video track over the existing peer connections.
let pendingDisplayPick = null;

function listDisplaySources() {
  return desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  });
}

// Ask the renderer to show the source picker and resolve with the chosen id
// (or null if the user cancels / the picker times out).
function requestDisplaySourcePick(sources) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) { resolve(sources[0] ? sources[0].id : null); return; }
    const list = sources.map((s) => {
      let thumb = '';
      try { thumb = (s.thumbnail && !s.thumbnail.isEmpty()) ? s.thumbnail.toDataURL() : ''; } catch (e) {}
      let icon = '';
      try { icon = (s.appIcon && !s.appIcon.isEmpty()) ? s.appIcon.toDataURL() : ''; } catch (e) {}
      return { id: s.id, name: s.name, thumbnail: thumb, appIcon: icon, isScreen: /^screen:/.test(s.id) };
    });
    const finish = (id) => {
      if (pendingDisplayPick) { clearTimeout(pendingDisplayPick.timer); pendingDisplayPick = null; }
      resolve(id || null);
    };
    pendingDisplayPick = { finish, timer: setTimeout(() => finish(null), 60000) };
    mainWindow.webContents.send('display-sources', list);
  });
}

ipcMain.on('display-source-pick', (e, id) => { if (pendingDisplayPick) pendingDisplayPick.finish(id); });
ipcMain.on('display-source-cancel', () => { if (pendingDisplayPick) pendingDisplayPick.finish(null); });

function configureScreenShare() {
  const ses = session.fromPartition('persist:hellobye');
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await listDisplaySources();
      if (!sources || !sources.length) { callback({}); return; }
      // Only one thing to share -> pick it automatically. Otherwise show the
      // in-app picker so the user chooses a screen or window.
      const chosenId = sources.length === 1
        ? sources[0].id
        : await requestDisplaySourcePick(sources);
      if (!chosenId) { callback({}); return; } // cancelled -> getDisplayMedia rejects
      const source = sources.find((s) => s.id === chosenId) || sources[0];
      const streams = { video: source };
      // System-audio loopback is only supported on Windows. On other platforms
      // we hand back video only; the page retries video-only anyway.
      if (request.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
      callback(streams);
    } catch (e) {
      try { callback({}); } catch (e2) {}
    }
  });
}

// ---- Soft update detection ----
async function fetchBuildId() {
  try {
    const res = await fetch(VERSION_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.buildId ? String(data.buildId) : null;
  } catch (e) {
    return null;
  }
}

async function checkForUpdate() {
  const id = await fetchBuildId();
  if (!id) return;
  if (knownBuildId === null) {
    // First successful check: record the current build. If it differs from the
    // build we last ran, the site was updated while the app was closed — show
    // the soft update toast right away.
    knownBuildId = id;
    const prev = readState().lastBuildId;
    if (prev && prev !== id) showSoftUpdate();
    writeState({ lastBuildId: id });
    return;
  }
  if (id !== knownBuildId) {
    knownBuildId = id;
    writeState({ lastBuildId: id });
    showSoftUpdate();
  }
}

// Ask the renderer to show the soft-update toast. If the renderer isn't ready
// (e.g. still loading), fall back to a native dialog.
function showSoftUpdate() {
  if (updatePending) return;
  updatePending = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('soft-update-available');
  } else {
    promptRestart();
  }
}

function promptRestart() {
  const choice = dialog.showMessageBoxSync(mainWindow || undefined, {
    type: 'info',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update available',
    message: 'A new version of Hellobye is available.',
    detail: 'The app will restart to apply the latest changes. Your login and data are kept.',
  });
  if (choice === 0) applyUpdate();
}

// Restart the whole client so the freshly deployed build is loaded cleanly.
function applyUpdate() {
  updatePending = false;
  try { if (knownBuildId) writeState({ lastBuildId: knownBuildId }); } catch (e) {}
  app.relaunch();
  app.exit(0);
}

function startUpdatePolling() {
  if (updateTimer) clearInterval(updateTimer);
  checkForUpdate();
  updateTimer = setInterval(checkForUpdate, POLL_INTERVAL_MS);
}

// ---- Menu ----
// There is deliberately NO application menu and NO in-app File/View/Edit/Help
// bar. The app is a native window with its own title bar only.
function buildMenu() {
  Menu.setApplicationMenu(null);
}

// ---- IPC from renderer ----
ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('check-update-now', async () => { await checkForUpdate(); return true; });
ipcMain.on('apply-update', () => applyUpdate());
ipcMain.on('dismiss-update', () => { updatePending = false; });
// Custom title-bar window controls.
ipcMain.on('window-minimize', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); });
ipcMain.on('window-maximize-toggle', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.on('window-close', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); });
ipcMain.on('window-toggle-fullscreen', () => toggleFullScreen());
ipcMain.handle('window-is-maximized', () => !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()));
ipcMain.handle('window-is-fullscreen', () => !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()));

// ---- Lifecycle ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    configurePermissions();
    configureScreenShare();
    buildMenu();
    createSplash();
    createWindow();
    startUpdatePolling();
    revealWhenReady();

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
