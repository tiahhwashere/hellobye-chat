
const { app, BrowserWindow, shell, session, Menu, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const APP_URL = process.env.HELLOBYE_URL || 'https://hellobye-chat.onrender.com/';
const VERSION_URL = new URL('/api/version', APP_URL).toString();
const POLL_INTERVAL_MS = 30 * 1000;

const DEFAULT_ZOOM = 0.6;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.5;
const ZOOM_STEP = 0.1;

const SPLASH_MIN_MS = 1700;

let mainWindow = null;
let splashWindow = null;
let updateTimer = null;
let knownBuildId = null;
let updatePending = false;

app.setName('Hellobye');
if (process.platform === 'win32') app.setAppUserModelId('com.hellobye.chat');

function statePath() { return path.join(app.getPath('userData'), 'desktop-state.json'); }
function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { return {}; }
}
function writeState(patch) {
  try {
    const s = Object.assign(readState(), patch);
    fs.writeFileSync(statePath(), JSON.stringify(s, null, 2));
  } catch (e) {  }
}

/* Carryover login: the full-app cleanup wipes userData (which holds the
   persistent session partition), so we stash the last signed-in account in a
   folder the cleanup deliberately leaves alone. On the next launch the new
   build can offer to sign the user back in with that account. */
function carryoverDir() {
  try { return path.join(app.getPath('appData'), 'HellobyeCarryover'); }
  catch (e) { return path.join(os.tmpdir(), 'HellobyeCarryover'); }
}
function carryoverPath() { return path.join(carryoverDir(), 'last-login.json'); }
function readCarryover() {
  try { return JSON.parse(fs.readFileSync(carryoverPath(), 'utf8')); } catch (e) { return null; }
}
function writeCarryover(data) {
  try {
    fs.mkdirSync(carryoverDir(), { recursive: true });
    fs.writeFileSync(carryoverPath(), JSON.stringify(data, null, 2));
  } catch (e) {  }
}
function clearCarryover() {
  try { fs.unlinkSync(carryoverPath()); } catch (e) {  }
}

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

function revealWhenReady() {
  const minSplash = new Promise((r) => setTimeout(r, SPLASH_MIN_MS));
  const loaded = new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve();
    const wc = mainWindow.webContents;
    if (!wc.isLoading()) return resolve();
    wc.once('did-finish-load', () => resolve());
    setTimeout(resolve, 12000);
  });
  Promise.all([minSplash, loaded]).then(revealApp);
}

function createWindow() {
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
    frame: false,
    autoHideMenuBar: true,
    show: false,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:hellobye',
      backgroundThrottling: false,
      spellcheck: false,
      additionalArguments: ['--hb-zoom=' + DEFAULT_ZOOM],
    },
  });

  const savedWin = readState().window || {};
  if (savedWin.fullScreen) {
    try { mainWindow.setFullScreen(true); } catch (e) {}
  } else if (savedWin.maximized) {
    try { mainWindow.maximize(); } catch (e) {}
  }

  applyZoom(DEFAULT_ZOOM, false);

  mainWindow.loadURL(APP_URL);

  mainWindow.webContents.on('did-finish-load', () => applyZoom(currentZoom, false));

  mainWindow.on('maximize', () => { sendToRenderer('window-maximized', true); captureWindowState(); });
  mainWindow.on('unmaximize', () => { sendToRenderer('window-maximized', false); captureWindowState(); });
  mainWindow.on('enter-full-screen', () => { sendToRenderer('window-maximized', true); captureWindowState(); });
  mainWindow.on('leave-full-screen', () => { sendToRenderer('window-maximized', false); captureWindowState(); });
  mainWindow.on('close', captureWindowState);

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

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (input.key === 'F11') { event.preventDefault(); toggleFullScreen(); return; }
    if (ctrl && (input.key === '+' || input.key === '=')) { event.preventDefault(); zoomBy(ZOOM_STEP); return; }
    if (ctrl && input.key === '-') { event.preventDefault(); zoomBy(-ZOOM_STEP); return; }
    if (ctrl && input.key === '0') { event.preventDefault(); applyZoom(DEFAULT_ZOOM, true); return; }
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

function captureWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    writeState({
      window: {
        fullScreen: mainWindow.isFullScreen(),
        maximized: mainWindow.isMaximized(),
      },
    });
  } catch (e) {  }
}

function iconPath() {
  const ico = path.join(__dirname, 'assets', 'icon.ico');
  const png = path.join(__dirname, 'assets', 'icon.png');
  if (process.platform === 'win32' && fs.existsSync(ico)) return ico;
  if (fs.existsSync(png)) return png;
  return undefined;
}

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

function configurePermissions() {
  const ses = session.fromPartition('persist:hellobye');
  const allowed = new Set(['media', 'audioCapture', 'videoCapture', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission) => allowed.has(permission));
}

let pendingDisplayPick = null;

function listDisplaySources() {
  return desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  });
}

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
      const chosenId = sources.length === 1
        ? sources[0].id
        : await requestDisplaySourcePick(sources);
      if (!chosenId) { callback({}); return; }
      const source = sources.find((s) => s.id === chosenId) || sources[0];
      const streams = { video: source };
      if (request.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
      callback(streams);
    } catch (e) {
      try { callback({}); } catch (e2) {}
    }
  });
}

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

function showSoftUpdate() {
  if (updatePending) return;
  updatePending = true;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const send = () => sendToRenderer('soft-update-available');
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

const DOWNLOAD_URL = 'https://hellobye-chat.onrender.com/download';

function downloadNewBuild() {
  updatePending = false;
  try { if (knownBuildId) writeState({ lastBuildId: knownBuildId }); } catch (e) {}
  let scheduled = false;
  try { scheduled = scheduleSelfDelete(); } catch (e) {}
  if (!scheduled) { try { shell.openExternal(DOWNLOAD_URL); } catch (e) {} }
  setTimeout(() => { try { app.exit(0); } catch (e) { app.quit(); } }, 700);
}

function scheduleSelfDelete() {
  if (process.platform !== 'win32' || !app.isPackaged) return false;
  const execPath = process.execPath;
  const exeName = path.basename(execPath);
  const installDir = path.dirname(execPath);
  const installParent = path.dirname(installDir);
  const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE;
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE || execPath;

  let userDataDir = '';
  try { userDataDir = app.getPath('userData'); } catch (e) {}
  const appDataRoaming = process.env.APPDATA || '';
  const appDataLocal = process.env.LOCALAPPDATA || '';
  const userProfile = process.env.USERPROFILE || '';
  const publicDir = process.env.PUBLIC || 'C:\\Users\\Public';
  const programData = process.env.ProgramData || process.env.PROGRAMDATA || 'C:\\ProgramData';
  const downloadsDir = userProfile ? path.join(userProfile, 'Downloads') : '';

  const s = (v) => '"' + String(v).replace(/"/g, '""') + '"';

  const folderTargets = [];
  const fileTargets = [];
  const regTargets = [];

  if (isPortable) {
    fileTargets.push(portableExe);
  } else {
    const installRoot = path.parse(installDir).root;
    if (installDir && installDir !== installRoot) folderTargets.push(installDir);
    if (installParent && /hellobye/i.test(path.basename(installParent))) folderTargets.push(installParent);
  }
  if (appDataLocal) {
    folderTargets.push(path.join(appDataLocal, 'Programs', 'HelloBye'));
    folderTargets.push(path.join(appDataLocal, 'HelloBye'));
    folderTargets.push(path.join(appDataLocal, 'hellobye-desktop'));
  }
  if (appDataRoaming) {
    folderTargets.push(path.join(appDataRoaming, 'HelloBye'));
    folderTargets.push(path.join(appDataRoaming, 'hellobye-desktop'));
  }
  if (userDataDir) folderTargets.push(userDataDir);

  const lnkNames = ['HelloBye.lnk', 'Hellobye.lnk', 'HelloBye Chat.lnk', 'hellobye-desktop.lnk'];
  if (userProfile) lnkNames.forEach(n => fileTargets.push(path.join(userProfile, 'Desktop', n)));
  if (publicDir) lnkNames.forEach(n => fileTargets.push(path.join(publicDir, 'Desktop', n)));
  if (appDataRoaming) lnkNames.forEach(n => fileTargets.push(path.join(appDataRoaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', n)));
  if (programData) lnkNames.forEach(n => fileTargets.push(path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', n)));

  regTargets.push('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\HelloBye\\');
  regTargets.push('HKCU\\Software\\HelloBye\\');
  regTargets.push('HKCU\\Software\\com.hellobye.chat\\');
  regTargets.push('HKCU\\Software\\hellobye-desktop\\');

  const vbsPath = path.join(os.tmpdir(), 'hellobye-cleanup-' + Date.now() + '.vbs');

  const lines = [];
  lines.push('Option Explicit');
  lines.push('On Error Resume Next');
  lines.push('Dim sh, fso, wmi, reg, procs, n, p, folderList, fileList, regList');
  lines.push('Set sh = CreateObject("WScript.Shell")');
  lines.push('Set fso = CreateObject("Scripting.FileSystemObject")');
  lines.push('Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")');
  lines.push('Set reg = GetObject("winmgmts:\\\\.\\root\\default:StdRegProv")');
  lines.push('n = 0');
  lines.push('Do While n < 120');
  lines.push('  Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = \'' + exeName + '\'")');
  lines.push('  If procs.Count = 0 Then Exit Do');
  lines.push('  WScript.Sleep 500');
  lines.push('  n = n + 1');
  lines.push('Loop');
  lines.push('WScript.Sleep 1500');
  lines.push('folderList = Array(' + folderTargets.map(s).join(', ') + ')');
  lines.push('fileList = Array(' + fileTargets.map(s).join(', ') + ')');
  lines.push('regList = Array(' + regTargets.map(s).join(', ') + ')');
  lines.push('Dim dlDir');
  lines.push('dlDir = ' + s(downloadsDir));
  lines.push('For Each p In folderList');
  lines.push('  If Len(p) > 0 Then DelFolder p');
  lines.push('Next');
  lines.push('For Each p In fileList');
  lines.push('  If Len(p) > 0 Then DelFile p');
  lines.push('Next');
  lines.push('For Each p In regList');
  lines.push('  If Len(p) > 0 Then sh.RegDelete p');
  lines.push('Next');
  lines.push('If Len(dlDir) > 0 Then CleanDownloads dlDir');
  lines.push('Dim base, subKeys, sk, kk, disp');
  lines.push('base = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"');
  lines.push('For Each sk In Array(-2147483647, -2147483646)');
  lines.push('  subKeys = Null');
  lines.push('  reg.EnumKey sk, base, subKeys');
  lines.push('  If IsArray(subKeys) Then');
  lines.push('    For Each kk In subKeys');
  lines.push('      disp = ""');
  lines.push('      reg.GetStringValue sk, base & "\\" & kk, "DisplayName", disp');
  lines.push('      If Not IsNull(disp) Then');
  lines.push('        If InStr(LCase(disp), "hellobye") > 0 Then reg.DeleteKey sk, base & "\\" & kk');
  lines.push('      End If');
  lines.push('    Next');
  lines.push('  End If');
  lines.push('Next');
  lines.push('WScript.Sleep 400');
  lines.push('sh.Run ' + s(DOWNLOAD_URL) + ', 1, False');
  lines.push('WScript.Sleep 800');
  lines.push('fso.DeleteFile WScript.ScriptFullName, True');
  lines.push('Sub CleanDownloads(dp)');
  lines.push('  Dim f, nm');
  lines.push('  If Not fso.FolderExists(dp) Then Exit Sub');
  lines.push('  For Each f In fso.GetFolder(dp).Files');
  lines.push('    nm = LCase(f.Name)');
  lines.push('    If InStr(nm, "hellobye") > 0 And Right(nm, 4) = ".exe" Then');
  lines.push('      fso.DeleteFile f.Path, True');
  lines.push('    End If');
  lines.push('  Next');
  lines.push('End Sub');
  lines.push('Sub DelFolder(fp)');
  lines.push('  Dim t');
  lines.push('  For t = 1 To 60');
  lines.push('    If Not fso.FolderExists(fp) Then Exit Sub');
  lines.push('    fso.DeleteFolder fp, True');
  lines.push('    WScript.Sleep 500');
  lines.push('  Next');
  lines.push('End Sub');
  lines.push('Sub DelFile(fp)');
  lines.push('  Dim t');
  lines.push('  For t = 1 To 40');
  lines.push('    If Not fso.FileExists(fp) Then Exit Sub');
  lines.push('    fso.DeleteFile fp, True');
  lines.push('    WScript.Sleep 300');
  lines.push('  Next');
  lines.push('End Sub');

  fs.writeFileSync(vbsPath, lines.join('\r\n'), 'utf8');
  const child = spawn('wscript.exe', ['//B', vbsPath], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return true;
}
function startUpdatePolling() {
  if (updateTimer) clearInterval(updateTimer);
  checkForUpdate();
  updateTimer = setInterval(checkForUpdate, POLL_INTERVAL_MS);
}

function buildMenu() {
  Menu.setApplicationMenu(null);
}

ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('get-last-login', () => readCarryover());
ipcMain.on('save-last-login', (e, data) => {
  if (!data || !data.username) return;
  writeCarryover({
    username: String(data.username),
    sessionId: data.sessionId ? String(data.sessionId) : '',
    at: Date.now(),
  });
});
ipcMain.on('clear-last-login', () => clearCarryover());
ipcMain.handle('check-update-now', async () => { await checkForUpdate(); return true; });
ipcMain.on('download-new-build', () => downloadNewBuild());
ipcMain.on('dismiss-update', () => { updatePending = false; });
ipcMain.on('window-minimize', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); });
ipcMain.on('window-maximize-toggle', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.on('window-close', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); });
ipcMain.on('window-toggle-fullscreen', () => toggleFullScreen());
ipcMain.handle('window-is-maximized', () => !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()));
ipcMain.handle('window-is-fullscreen', () => !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()));

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
