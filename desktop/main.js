// HelloBye Desktop — Electron wrapper around the HelloBye web app.
//
// Features:
//  - Loads the live site in a native window (persistent login via a fixed
//    userData partition so cookies/localStorage survive restarts).
//  - Grants microphone access automatically so voice chat works out of the box.
//  - "Soft update": polls the site's /api/version endpoint. When the deployed
//    build id changes (a new deploy landed), it shows a soft in-app update
//    banner and reloads the window to apply the update — no reinstall needed.
//  - Native menu, external-link handling, and a single-instance lock.

const { app, BrowserWindow, shell, session, Menu, dialog, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// The live site. Override with HELLOBYE_URL for local testing.
const APP_URL = process.env.HELLOBYE_URL || 'https://hellobye-chat.onrender.com/';
const VERSION_URL = new URL('/api/version', APP_URL).toString();
const POLL_INTERVAL_MS = 30 * 1000; // check for updates every 30s

let mainWindow = null;
let updateTimer = null;
let knownBuildId = null;
let updatePending = false;

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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#1a1b1e',
    title: 'HelloBye',
    autoHideMenuBar: false,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A fixed partition keeps the login session across app restarts.
      partition: 'persist:hellobye',
      backgroundThrottling: false,
    },
  });

  mainWindow.loadURL(APP_URL);

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

  mainWindow.on('closed', () => { mainWindow = null; });
}

function iconPath() {
  const ico = path.join(__dirname, 'assets', 'icon.ico');
  const png = path.join(__dirname, 'assets', 'icon.png');
  if (process.platform === 'win32' && fs.existsSync(ico)) return ico;
  if (fs.existsSync(png)) return png;
  return undefined;
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
    // the soft update banner right away.
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

// Ask the renderer to show the soft-update banner. If the renderer isn't
// ready (e.g. still loading), fall back to a native dialog.
function showSoftUpdate() {
  if (updatePending) return;
  updatePending = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('soft-update-available');
  } else {
    promptReload();
  }
}

function promptReload() {
  const choice = dialog.showMessageBoxSync(mainWindow || undefined, {
    type: 'info',
    buttons: ['Update now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update available',
    message: 'A new version of HelloBye is available.',
    detail: 'The app will reload to apply the latest changes. Your login and data are kept.',
  });
  if (choice === 0) applyUpdate();
}

function applyUpdate() {
  updatePending = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reloadIgnoringCache();
  }
}

function startUpdatePolling() {
  if (updateTimer) clearInterval(updateTimer);
  checkForUpdate();
  updateTimer = setInterval(checkForUpdate, POLL_INTERVAL_MS);
}

// ---- Menu ----
function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.webContents.reload() },
        { label: 'Check for updates', click: () => checkForUpdate() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Toggle Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow && mainWindow.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'HelloBye website', click: () => shell.openExternal('https://hellobye-chat.onrender.com/') },
        { label: 'About HelloBye', click: () => dialog.showMessageBox(mainWindow || undefined, {
            type: 'info', title: 'About HelloBye',
            message: 'HelloBye Desktop ' + app.getVersion(),
            detail: 'A native desktop app for HelloBye Chat.\n\nIt automatically checks for website updates and applies them softly — no reinstall required.',
          }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC from renderer ----
ipcMain.handle('app-version', () => app.getVersion());
ipcMain.on('apply-update', () => applyUpdate());
ipcMain.on('dismiss-update', () => { updatePending = false; });
ipcMain.handle('check-update-now', async () => { await checkForUpdate(); return true; });

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
