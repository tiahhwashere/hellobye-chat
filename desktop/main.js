// HelloBye Desktop — a native Electron app for HelloBye Chat.
//
// Design goals (this build):
//  - Feel like a real PC application, not a website embedded in a window.
//    The window is frameless with a custom native title bar (drag region +
//    minimise / maximise / close controls) drawn by preload.js.
//  - Open at 60% of the screen by default.
//  - No File / View / Edit / Help menu bar at all.
//  - "Soft update": poll the site's /api/version endpoint. When the deployed
//    build id changes, show a soft in-app toast. Applying the update RESTARTS
//    the whole client (relaunch) so the new build is loaded cleanly — no page
//    refresh, and the login/data are kept (persistent partition).
//  - Microphone/camera permissions are granted automatically so voice works.

const { app, BrowserWindow, shell, session, Menu, dialog, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// The live site. Override with HELLOBYE_URL for local testing.
const APP_URL = process.env.HELLOBYE_URL || 'https://hellobye-chat.onrender.com/';
const VERSION_URL = new URL('/api/version', APP_URL).toString();
const POLL_INTERVAL_MS = 30 * 1000; // check for updates every 30s
const TITLEBAR_HEIGHT = 36;         // must match the CSS in preload.js

let mainWindow = null;
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
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A fixed partition keeps the login session across app restarts.
      partition: 'persist:hellobye',
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(APP_URL);

  // Keep the renderer's maximise/restore icon in sync.
  mainWindow.on('maximize', () => sendToRenderer('window-maximized', true));
  mainWindow.on('unmaximize', () => sendToRenderer('window-maximized', false));

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
    if (ctrl && (input.key === '+' || input.key === '=')) { event.preventDefault(); zoomBy(0.5); return; }
    if (ctrl && input.key === '-') { event.preventDefault(); zoomBy(-0.5); return; }
    if (ctrl && input.key === '0') { event.preventDefault(); setZoom(0); return; }
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
function zoomBy(delta) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  setZoom(mainWindow.webContents.getZoomLevel() + delta);
}
function setZoom(level) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.setZoomLevel(level);
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
ipcMain.handle('window-is-maximized', () => !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()));

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
    buildMenu();
    createWindow();
    startUpdatePolling();

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
