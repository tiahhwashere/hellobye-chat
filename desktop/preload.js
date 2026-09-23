// Preload — runs inside the loaded HelloBye page.
//
// It exposes a tiny, safe bridge to the renderer AND injects the native-app
// chrome: a custom title bar (the window is frameless) and the "soft update"
// toast. There is deliberately NO File / View / Edit / Help menu bar.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hellobyeDesktop', {
  isDesktop: true,
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('app-version'),
  checkForUpdate: () => ipcRenderer.invoke('check-update-now'),
  applyUpdate: () => ipcRenderer.send('apply-update'),
  dismissUpdate: () => ipcRenderer.send('dismiss-update'),
  // Native window controls (driven by the custom title bar).
  minimize: () => ipcRenderer.send('window-minimize'),
  maximizeToggle: () => ipcRenderer.send('window-maximize-toggle'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onMaximized: (cb) => { if (typeof cb === 'function') ipcRenderer.on('window-maximized', (e, v) => cb(!!v)); },
  onSoftUpdate: (cb) => { if (typeof cb === 'function') ipcRenderer.on('soft-update-available', () => cb()); },
});

// Mark the document as running inside the native app as early as possible so
// the page can hide website-only chrome and skip its own refresh popup.
try { document.documentElement.classList.add('hb-desktop'); } catch (e) {}

// ============================================================
// Native title bar (the window is frameless)
// ============================================================
const TITLEBAR_HEIGHT = 36;

function injectTitlebarStyles() {
  if (document.getElementById('hb-titlebar-style')) return;
  const style = document.createElement('style');
  style.id = 'hb-titlebar-style';
  style.textContent = `
    #hb-titlebar {
      position: fixed; top: 0; left: 0; right: 0; height: ${TITLEBAR_HEIGHT}px;
      z-index: 2147483600; display: flex; align-items: center; justify-content: space-between;
      background: #16171a; border-bottom: 1px solid rgba(255,255,255,0.06);
      color: #d7d9e0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      font-size: 12.5px; user-select: none; -webkit-user-select: none;
      -webkit-app-region: drag;
    }
    #hb-titlebar .hb-tb-left { display: flex; align-items: center; gap: 8px; padding-left: 12px; min-width: 0; }
    #hb-titlebar .hb-tb-logo {
      width: 16px; height: 16px; border-radius: 5px; flex: 0 0 auto;
      background: linear-gradient(135deg, #5865f2, #8b93ff);
      box-shadow: 0 0 8px rgba(88,101,242,.5);
    }
    #hb-titlebar .hb-tb-title { font-weight: 700; letter-spacing: .2px; color: #fff; white-space: nowrap; }
    #hb-titlebar .hb-tb-controls { display: flex; align-items: stretch; height: 100%; -webkit-app-region: no-drag; }
    #hb-titlebar .hb-tb-btn {
      width: 46px; display: flex; align-items: center; justify-content: center;
      cursor: pointer; color: #c7c9d1; transition: background .12s ease, color .12s ease;
    }
    #hb-titlebar .hb-tb-btn:hover { background: rgba(255,255,255,0.09); color: #fff; }
    #hb-titlebar .hb-tb-btn.hb-close:hover { background: #e81123; color: #fff; }
    #hb-titlebar .hb-tb-btn svg { width: 11px; height: 11px; display: block; }

    /* Reserve space for the title bar so app content sits below it. */
    html.hb-desktop #chat-app { height: calc(100dvh - ${TITLEBAR_HEIGHT}px) !important; margin-top: ${TITLEBAR_HEIGHT}px; }
    html.hb-desktop #servers-app { height: calc(100dvh - ${TITLEBAR_HEIGHT}px) !important; margin-top: ${TITLEBAR_HEIGHT}px; }
    html.hb-desktop #auth-screen { top: ${TITLEBAR_HEIGHT}px; }
    @supports not (height: 100dvh) {
      html.hb-desktop #chat-app { height: calc(100vh - ${TITLEBAR_HEIGHT}px) !important; }
      html.hb-desktop #servers-app { height: calc(100vh - ${TITLEBAR_HEIGHT}px) !important; }
    }

    /* Hide website-only chrome inside the native app. */
    html.hb-desktop #download-pc-btn { display: none !important; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

const ICON_MIN = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><line x1="1.5" y1="6" x2="10.5" y2="6"/></svg>';
const ICON_MAX = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="1.7" y="1.7" width="8.6" height="8.6" rx="1"/></svg>';
const ICON_RESTORE = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="1.4" y="3.4" width="7.2" height="7.2" rx="1"/><path d="M3.6 3.4V2.4a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><line x1="1.8" y1="1.8" x2="10.2" y2="10.2"/><line x1="10.2" y1="1.8" x2="1.8" y2="10.2"/></svg>';

let titlebarEl = null;
let maxBtnEl = null;

function buildTitlebar() {
  if (document.getElementById('hb-titlebar')) return;
  injectTitlebarStyles();

  const bar = document.createElement('div');
  bar.id = 'hb-titlebar';
  bar.innerHTML =
    '<div class="hb-tb-left">' +
      '<span class="hb-tb-logo"></span>' +
      '<span class="hb-tb-title">Hellobye</span>' +
    '</div>' +
    '<div class="hb-tb-controls">' +
      '<div class="hb-tb-btn" id="hb-tb-min" title="Minimize">' + ICON_MIN + '</div>' +
      '<div class="hb-tb-btn" id="hb-tb-max" title="Maximize">' + ICON_MAX + '</div>' +
      '<div class="hb-tb-btn hb-close" id="hb-tb-close" title="Close">' + ICON_CLOSE + '</div>' +
    '</div>';
  document.body.appendChild(bar);
  titlebarEl = bar;
  maxBtnEl = bar.querySelector('#hb-tb-max');

  bar.querySelector('#hb-tb-min').addEventListener('click', () => ipcRenderer.send('window-minimize'));
  bar.querySelector('#hb-tb-max').addEventListener('click', () => ipcRenderer.send('window-maximize-toggle'));
  bar.querySelector('#hb-tb-close').addEventListener('click', () => ipcRenderer.send('window-close'));

  // Keep the maximise/restore icon in sync with the real window state.
  const setMaxIcon = (isMax) => {
    if (!maxBtnEl) return;
    maxBtnEl.innerHTML = isMax ? ICON_RESTORE : ICON_MAX;
    maxBtnEl.title = isMax ? 'Restore' : 'Maximize';
  };
  ipcRenderer.on('window-maximized', (e, v) => setMaxIcon(!!v));
  try { ipcRenderer.invoke('window-is-maximized').then(setMaxIcon).catch(() => {}); } catch (e) {}
}

// ============================================================
// Soft-update toast — restarts the whole client to apply updates
// ============================================================
function injectToastStyles() {
  if (document.getElementById('hb-update-style')) return;
  const style = document.createElement('style');
  style.id = 'hb-update-style';
  style.textContent = `
    #hb-update-toast {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
      width: min(380px, calc(100vw - 40px)); overflow: hidden;
      background: linear-gradient(180deg, #202127, #16171b);
      border: 1px solid rgba(255,255,255,0.09); border-radius: 16px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.35);
      color: #e9eaee; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      transform: translateY(24px) scale(0.98); opacity: 0; pointer-events: none;
      transition: transform .34s cubic-bezier(.2,.9,.3,1.15), opacity .28s ease;
    }
    #hb-update-toast.show { transform: translateY(0) scale(1); opacity: 1; pointer-events: auto; }
    #hb-update-toast .hb-ut-accent { height: 3px; width: 100%; background: linear-gradient(90deg, #5865f2, #8b93ff, #5865f2); }
    #hb-update-toast .hb-ut-body { padding: 16px 18px 15px; }
    #hb-update-toast .hb-ut-head { display: flex; align-items: center; gap: 12px; margin-bottom: 11px; }
    #hb-update-toast .hb-ut-icon {
      width: 38px; height: 38px; flex: 0 0 auto; border-radius: 11px;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg, rgba(88,101,242,0.28), rgba(139,147,255,0.16));
      border: 1px solid rgba(139,147,255,0.35); color: #aab1ff;
    }
    #hb-update-toast .hb-ut-icon svg { width: 19px; height: 19px; }
    #hb-update-toast .hb-ut-headtext { min-width: 0; }
    #hb-update-toast .hb-ut-title { font-size: 14.5px; font-weight: 800; letter-spacing: .01em; color: #fff; }
    #hb-update-toast .hb-ut-sub { font-size: 11.5px; color: #8a8d96; margin-top: 1px; }
    #hb-update-toast .hb-ut-text { font-size: 12.8px; color: #a9abb3; line-height: 1.55; margin-bottom: 14px; }
    #hb-update-toast .hb-ut-text b { color: #c9ccff; font-weight: 700; }
    #hb-update-toast .hb-ut-actions { display: flex; gap: 9px; }
    #hb-update-toast button {
      font: inherit; font-size: 12.8px; font-weight: 700; cursor: pointer;
      border-radius: 10px; padding: 10px 14px; border: 1px solid transparent;
      transition: filter .15s ease, background .15s ease, opacity .15s ease;
    }
    #hb-update-toast .hb-ut-restart { flex: 1 1 auto; background: #5865f2; color: #fff; }
    #hb-update-toast .hb-ut-restart:hover { filter: brightness(1.1); }
    #hb-update-toast .hb-ut-later { flex: 0 0 auto; background: transparent; color: #c7c9d1; border-color: rgba(255,255,255,0.14); }
    #hb-update-toast .hb-ut-later:hover { background: rgba(255,255,255,0.06); }
    #hb-update-toast .hb-ut-count { margin-top: 11px; font-size: 11.5px; color: #8a8d96; text-align: center; }
    #hb-update-toast .hb-ut-count b { color: #aab1ff; }
    #hb-update-toast .hb-ut-progress { height: 3px; width: 100%; background: rgba(255,255,255,0.06); }
    #hb-update-toast .hb-ut-progress span {
      display: block; height: 100%; width: 100%; transform-origin: left;
      background: linear-gradient(90deg, #5865f2, #8b93ff);
    }
    #hb-update-toast.restarting .hb-ut-actions { opacity: .5; pointer-events: none; }
    #hb-update-toast.restarting .hb-ut-icon svg { animation: hb-ut-spin 1s linear infinite; }
    @keyframes hb-ut-spin { to { transform: rotate(360deg); } }
  `;
  (document.head || document.documentElement).appendChild(style);
}

let toastEl = null;
let countdownTimer = null;
const COUNTDOWN = 20;

function showToast() {
  injectToastStyles();
  if (toastEl) { toastEl.classList.add('show'); return; }

  toastEl = document.createElement('div');
  toastEl.id = 'hb-update-toast';
  toastEl.innerHTML =
    '<div class="hb-ut-accent"></div>' +
    '<div class="hb-ut-body">' +
      '<div class="hb-ut-head">' +
        '<span class="hb-ut-icon">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/>' +
          '</svg>' +
        '</span>' +
        '<div class="hb-ut-headtext">' +
          '<div class="hb-ut-title">Update ready</div>' +
          '<div class="hb-ut-sub" id="hb-ut-sub">Hellobye for PC</div>' +
        '</div>' +
      '</div>' +
      '<div class="hb-ut-text">A new version of Hellobye is available. Restart the app to apply it \u2014 your login and data are kept.</div>' +
      '<div class="hb-ut-actions">' +
        '<button class="hb-ut-later" id="hb-ut-later" type="button">Later</button>' +
        '<button class="hb-ut-restart" id="hb-ut-restart" type="button">Restart now</button>' +
      '</div>' +
      '<div class="hb-ut-count">Restarting automatically in <b id="hb-ut-count">' + COUNTDOWN + '</b>s</div>' +
    '</div>' +
    '<div class="hb-ut-progress"><span id="hb-ut-progress"></span></div>';
  document.body.appendChild(toastEl);
  requestAnimationFrame(() => toastEl.classList.add('show'));

  // Fill in the app version.
  try {
    ipcRenderer.invoke('app-version').then((v) => {
      const sub = toastEl && toastEl.querySelector('#hb-ut-sub');
      if (sub && v) sub.textContent = 'Hellobye for PC \u00b7 v' + v;
    }).catch(() => {});
  } catch (e) {}

  const prog = toastEl.querySelector('#hb-ut-progress');
  if (prog) {
    prog.style.transition = 'transform ' + COUNTDOWN + 's linear';
    requestAnimationFrame(() => { prog.style.transform = 'scaleX(0)'; });
  }

  toastEl.querySelector('#hb-ut-restart').addEventListener('click', doRestart);
  toastEl.querySelector('#hb-ut-later').addEventListener('click', () => {
    clearInterval(countdownTimer);
    ipcRenderer.send('dismiss-update');
    if (toastEl) toastEl.classList.remove('show');
  });

  let remaining = COUNTDOWN;
  const cd = toastEl.querySelector('#hb-ut-count');
  countdownTimer = setInterval(() => {
    remaining -= 1;
    if (cd) cd.textContent = String(Math.max(0, remaining));
    if (remaining <= 0) { clearInterval(countdownTimer); doRestart(); }
  }, 1000);
}

function doRestart() {
  clearInterval(countdownTimer);
  if (toastEl) {
    toastEl.classList.add('restarting');
    const title = toastEl.querySelector('.hb-ut-title');
    const text = toastEl.querySelector('.hb-ut-text');
    const count = toastEl.querySelector('.hb-ut-count');
    if (title) title.textContent = 'Restarting\u2026';
    if (text) text.textContent = 'Closing and reopening Hellobye to apply the update.';
    if (count) count.textContent = 'Please wait\u2026';
  }
  // Give the UI a beat to paint, then restart the whole client.
  setTimeout(() => ipcRenderer.send('apply-update'), 350);
}

ipcRenderer.on('soft-update-available', () => {
  if (document.body) showToast();
  else window.addEventListener('DOMContentLoaded', showToast, { once: true });
});

// ============================================================
// Native-app polish
// ============================================================
// Prevent dragging images out of the window (feels web-y). File drag & drop
// for uploads is intentionally left untouched.
document.addEventListener('dragstart', (e) => {
  const t = e.target;
  if (t && t.tagName === 'IMG') e.preventDefault();
});

// Boot the chrome.
function boot() {
  buildTitlebar();
}
if (document.body) boot();
else window.addEventListener('DOMContentLoaded', boot, { once: true });
