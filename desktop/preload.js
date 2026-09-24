// Preload — runs inside the loaded HelloBye page.
//
// It exposes a tiny, safe bridge to the renderer AND injects the native-app
// chrome: the window controls (minimise / maximise / close) and the "soft
// update" toast. There is deliberately NO File / View / Edit / Help menu bar
// and NO full-width title bar.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hellobyeDesktop', {
  isDesktop: true,
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('app-version'),
  checkForUpdate: () => ipcRenderer.invoke('check-update-now'),
  applyUpdate: () => ipcRenderer.send('apply-update'),
  dismissUpdate: () => ipcRenderer.send('dismiss-update'),
  // Native window controls (driven by the custom window-control cluster).
  minimize: () => ipcRenderer.send('window-minimize'),
  maximizeToggle: () => ipcRenderer.send('window-maximize-toggle'),
  close: () => ipcRenderer.send('window-close'),
  toggleFullscreen: () => ipcRenderer.send('window-toggle-fullscreen'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  isFullscreen: () => ipcRenderer.invoke('window-is-fullscreen'),
  onMaximized: (cb) => { if (typeof cb === 'function') ipcRenderer.on('window-maximized', (e, v) => cb(!!v)); },
  onSoftUpdate: (cb) => { if (typeof cb === 'function') ipcRenderer.on('soft-update-available', () => cb()); },
  // Screen-share source picker (Electron has no native picker; we render one).
  onDisplaySources: (cb) => { if (typeof cb === 'function') ipcRenderer.on('display-sources', (e, list) => cb(list)); },
  pickDisplaySource: (id) => ipcRenderer.send('display-source-pick', id),
  cancelDisplaySource: () => ipcRenderer.send('display-source-cancel'),
});

// Mark the document as running inside the native app as early as possible so
// the page can hide website-only chrome and skip its own refresh popup.
try { document.documentElement.classList.add('hb-desktop'); } catch (e) {}

// ============================================================
// Native window chrome (the window is frameless)
// ============================================================
// There is NO full-width title bar. Instead:
//   * a small cluster of window controls (minimise / maximise / close) is
//     pinned to the top-right, vertically aligned with the website's own
//     header row, and
//   * the app's top header row is made draggable, so the whole window can be
//     moved by dragging the top of the app.
// The app content is rendered zoomed out (see main.js), so every native-chrome
// dimension is counter-scaled by 1/zoom (the --hb-z variable) to keep it at its
// true pixel size.
const WC_BTN_W = 46; // window-control button width, in device px
const WC_H = 40;     // window-control cluster height, in device px

// Read the zoom factor that main.js passed via additionalArguments.
const ZOOM = (function () {
  try {
    const arg = (process.argv || []).find((a) => typeof a === 'string' && a.indexOf('--hb-zoom=') === 0);
    const v = arg ? parseFloat(arg.slice('--hb-zoom='.length)) : 1;
    return (isFinite(v) && v > 0.1 && v <= 2) ? v : 1;
  } catch (e) { return 1; }
})();

function setZoomVar(z) {
  try { document.documentElement.style.setProperty('--hb-z', String(z)); } catch (e) {}
}

function injectChromeStyles() {
  if (document.getElementById('hb-chrome-style')) return;
  setZoomVar(ZOOM);
  const style = document.createElement('style');
  style.id = 'hb-chrome-style';
  style.textContent = `
    :root { --hb-z: ${ZOOM}; }

    /* ---- Window controls: pinned to the top-right, vertically aligned with
       the website's own header row. There is NO full-width bar. ---- */
    #hb-wincontrols {
      position: fixed; top: 0; right: 0; z-index: 2147483600;
      display: flex; align-items: stretch;
      /* Height is synced to the website's own header row (see syncControlHeight)
         so the controls line up exactly with it on every page. */
      height: var(--hb-wc-h, calc(${WC_H}px / var(--hb-z)));
      -webkit-app-region: no-drag;
    }
    #hb-wincontrols .hb-wc-btn {
      width: calc(${WC_BTN_W}px / var(--hb-z));
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; color: #c7c9d1;
      transition: background .12s ease, color .12s ease;
    }
    #hb-wincontrols .hb-wc-btn:hover { background: rgba(255,255,255,0.10); color: #fff; }
    #hb-wincontrols .hb-wc-btn.hb-close:hover { background: #e81123; color: #fff; }
    #hb-wincontrols .hb-wc-btn svg { width: calc(11px / var(--hb-z)); height: calc(11px / var(--hb-z)); display: block; }

    /* ---- Make the whole app draggable from its top header row ---- */
    html.hb-desktop .sidebar-header,
    html.hb-desktop .chat-header,
    html.hb-desktop .server-header,
    html.hb-desktop .server-chat-header { -webkit-app-region: drag; }
    /* The server banner is clickable (opens Server Settings), so keep its top
       strip interactive while the rest of the banner stays draggable. */
    html.hb-desktop .server-header-top { -webkit-app-region: no-drag; }
    html.hb-desktop .sidebar-header button,
    html.hb-desktop .sidebar-header a,
    html.hb-desktop .sidebar-header input,
    html.hb-desktop .chat-header button,
    html.hb-desktop .chat-header a,
    html.hb-desktop .chat-header input,
    html.hb-desktop .server-header button,
    html.hb-desktop .server-header a,
    html.hb-desktop .server-header input,
    html.hb-desktop .server-chat-header button,
    html.hb-desktop .server-chat-header a,
    html.hb-desktop .server-chat-header input { -webkit-app-region: no-drag; }

    /* ---- Keep the website's own header buttons clear of the window controls ----
       On the servers page the action buttons (members toggle, search, pins,
       invite, settings) live in .server-chat-header, so that row needs the same
       right padding as the main chat header. */
    html.hb-desktop .chat-header,
    html.hb-desktop .server-chat-header {
      padding-right: calc(${WC_BTN_W * 3}px / var(--hb-z) + 10px) !important;
    }

    /* On the servers page the member sidebar is the right-most column, so its
       header (Members / Roles) would sit directly underneath the fixed window
       controls. Reserve the control height at the top of the sidebar so the
       Roles button clears the controls instead of overlapping them. */
    html.hb-desktop .member-sidebar:not(.collapsed) {
      padding-top: calc(var(--hb-wc-h, ${WC_H}px) + 12px) !important;
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

let maxBtnEl = null;

function buildWindowControls() {
  if (document.getElementById('hb-wincontrols')) return;
  injectChromeStyles();

  const bar = document.createElement('div');
  bar.id = 'hb-wincontrols';
  bar.innerHTML =
    '<div class="hb-wc-btn" id="hb-wc-min" title="Minimize">' + ICON_MIN + '</div>' +
    '<div class="hb-wc-btn" id="hb-wc-max" title="Maximize">' + ICON_MAX + '</div>' +
    '<div class="hb-wc-btn hb-close" id="hb-wc-close" title="Close">' + ICON_CLOSE + '</div>';
  document.body.appendChild(bar);
  maxBtnEl = bar.querySelector('#hb-wc-max');

  bar.querySelector('#hb-wc-min').addEventListener('click', () => ipcRenderer.send('window-minimize'));
  bar.querySelector('#hb-wc-max').addEventListener('click', () => ipcRenderer.send('window-maximize-toggle'));
  bar.querySelector('#hb-wc-close').addEventListener('click', () => ipcRenderer.send('window-close'));

  // Keep the maximise/restore icon in sync with the real window state.
  const setMaxIcon = (isMax) => {
    if (!maxBtnEl) return;
    maxBtnEl.innerHTML = isMax ? ICON_RESTORE : ICON_MAX;
    maxBtnEl.title = isMax ? 'Restore' : 'Maximize';
  };
  ipcRenderer.on('window-maximized', (e, v) => setMaxIcon(!!v));
  try { ipcRenderer.invoke('window-is-maximized').then(setMaxIcon).catch(() => {}); } catch (e) {}

  syncControlHeight();
  window.addEventListener('resize', syncControlHeight);
}

// Match the window-control cluster height to the website's own header row so
// the controls sit perfectly in line with it (the main chat header and the
// servers chat header are different heights).
function activeHeader() {
  return document.querySelector('.server-chat-header') ||
         document.querySelector('.chat-header') ||
         document.querySelector('.sidebar-header');
}
function syncControlHeight() {
  try {
    const hdr = activeHeader();
    if (!hdr) return;
    const h = hdr.getBoundingClientRect().height; // already in post-zoom CSS px
    if (h > 0) document.documentElement.style.setProperty('--hb-wc-h', h + 'px');
  } catch (e) {}
}

// Keep the control height in sync as the header appears / changes size (e.g.
// after login, or when switching between the chat and servers views).
function watchHeader() {
  let observed = null;
  let ro = null;
  const attach = () => {
    const hdr = activeHeader();
    if (!hdr || hdr === observed) return;
    observed = hdr;
    try {
      if (ro) ro.disconnect();
      ro = new ResizeObserver(() => syncControlHeight());
      ro.observe(hdr);
    } catch (e) {}
    syncControlHeight();
  };
  attach();
  try {
    const mo = new MutationObserver(() => attach());
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
}

// ============================================================
// Screen-share source picker
// ============================================================
// Electron has no built-in getDisplayMedia picker, so the main process sends
// us the list of screens/windows and we render a native-feeling chooser. The
// chosen source id goes back to main, which hands it to getDisplayMedia.
function injectShareStyles() {
  if (document.getElementById('hb-share-style')) return;
  const style = document.createElement('style');
  style.id = 'hb-share-style';
  style.textContent = `
    #hb-share-overlay {
      position: fixed; inset: 0; z-index: 2147483646;
      display: none; align-items: center; justify-content: center;
      background: rgba(6,7,10,0.72); backdrop-filter: blur(3px);
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      -webkit-app-region: no-drag;
    }
    #hb-share-overlay.show { display: flex; }
    #hb-share-card {
      width: min(880px, calc(100vw / var(--hb-z, 1) - 60px));
      max-height: calc(100vh / var(--hb-z, 1) - 80px);
      display: flex; flex-direction: column;
      background: linear-gradient(180deg, #202127, #16171b);
      border: 1px solid rgba(255,255,255,0.09); border-radius: 16px;
      box-shadow: 0 30px 80px rgba(0,0,0,0.65), 0 0 0 1px rgba(0,0,0,0.4);
      color: #e9eaee; overflow: hidden;
    }
    #hb-share-card .hb-sh-head { padding: 18px 20px 12px; }
    #hb-share-card .hb-sh-title { font-size: 16px; font-weight: 800; color: #fff; }
    #hb-share-card .hb-sh-sub { font-size: 12.5px; color: #8a8d96; margin-top: 3px; }
    #hb-share-card .hb-sh-grid {
      padding: 6px 20px 16px; overflow-y: auto;
      display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px;
    }
    #hb-share-card .hb-sh-item {
      cursor: pointer; border-radius: 12px; overflow: hidden;
      background: #23242a; border: 2px solid transparent;
      transition: border-color .12s ease, transform .12s ease, background .12s ease;
      display: flex; flex-direction: column;
    }
    #hb-share-card .hb-sh-item:hover { border-color: #5865f2; background: #2a2b33; transform: translateY(-1px); }
    #hb-share-card .hb-sh-thumb {
      width: 100%; aspect-ratio: 16 / 10; object-fit: cover; display: block;
      background: #101116;
    }
    #hb-share-card .hb-sh-empty-thumb {
      width: 100%; aspect-ratio: 16 / 10; display: flex; align-items: center; justify-content: center;
      background: #101116; color: #4a4d57;
    }
    #hb-share-card .hb-sh-empty-thumb svg { width: 34px; height: 34px; }
    #hb-share-card .hb-sh-meta { display: flex; align-items: center; gap: 8px; padding: 9px 11px; min-width: 0; }
    #hb-share-card .hb-sh-icon { width: 18px; height: 18px; flex: 0 0 auto; border-radius: 4px; object-fit: contain; }
    #hb-share-card .hb-sh-name {
      font-size: 12.5px; font-weight: 600; color: #d6d8df; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    #hb-share-card .hb-sh-tag {
      flex: 0 0 auto; font-size: 10px; font-weight: 800; letter-spacing: .04em;
      text-transform: uppercase; color: #aab1ff; background: rgba(88,101,242,0.16);
      border: 1px solid rgba(139,147,255,0.3); border-radius: 6px; padding: 2px 6px;
    }
    #hb-share-card .hb-sh-foot {
      display: flex; justify-content: flex-end; gap: 10px;
      padding: 14px 20px; border-top: 1px solid rgba(255,255,255,0.07);
    }
    #hb-share-card .hb-sh-foot button {
      font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
      border-radius: 10px; padding: 10px 16px; border: 1px solid transparent;
    }
    #hb-share-card .hb-sh-cancel { background: transparent; color: #c7c9d1; border-color: rgba(255,255,255,0.14); }
    #hb-share-card .hb-sh-cancel:hover { background: rgba(255,255,255,0.06); }
  `;
  (document.head || document.documentElement).appendChild(style);
}

let shareOverlay = null;

function buildSharePicker() {
  if (document.getElementById('hb-share-overlay')) return;
  injectShareStyles();
  shareOverlay = document.createElement('div');
  shareOverlay.id = 'hb-share-overlay';
  shareOverlay.innerHTML =
    '<div id="hb-share-card">' +
      '<div class="hb-sh-head">' +
        '<div class="hb-sh-title">Share your screen</div>' +
        '<div class="hb-sh-sub">Choose a screen or window to show everyone in the call.</div>' +
      '</div>' +
      '<div class="hb-sh-grid" id="hb-sh-grid"></div>' +
      '<div class="hb-sh-foot">' +
        '<button class="hb-sh-cancel" id="hb-sh-cancel" type="button">Cancel</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(shareOverlay);
  shareOverlay.querySelector('#hb-sh-cancel').addEventListener('click', () => {
    hideSharePicker();
    ipcRenderer.send('display-source-cancel');
  });
  shareOverlay.addEventListener('click', (e) => {
    if (e.target === shareOverlay) { hideSharePicker(); ipcRenderer.send('display-source-cancel'); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shareOverlay && shareOverlay.classList.contains('show')) {
      hideSharePicker();
      ipcRenderer.send('display-source-cancel');
    }
  });
}

function hideSharePicker() {
  if (shareOverlay) shareOverlay.classList.remove('show');
}

const SHARE_MONITOR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';

function showSharePicker(sources) {
  buildSharePicker();
  const grid = shareOverlay.querySelector('#hb-sh-grid');
  grid.innerHTML = '';
  sources.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'hb-sh-item';
    const thumb = s.thumbnail
      ? '<img class="hb-sh-thumb" src="' + s.thumbnail + '" alt="">'
      : '<div class="hb-sh-empty-thumb">' + SHARE_MONITOR_ICON + '</div>';
    const icon = s.appIcon ? '<img class="hb-sh-icon" src="' + s.appIcon + '" alt="">' : '';
    const tag = s.isScreen ? '<span class="hb-sh-tag">Screen</span>' : '<span class="hb-sh-tag">Window</span>';
    item.innerHTML =
      thumb +
      '<div class="hb-sh-meta">' + icon +
        '<span class="hb-sh-name">' + (s.name || 'Untitled') + '</span>' + tag +
      '</div>';
    item.addEventListener('click', () => {
      hideSharePicker();
      ipcRenderer.send('display-source-pick', s.id);
    });
    grid.appendChild(item);
  });
  shareOverlay.classList.add('show');
}

ipcRenderer.on('display-sources', (e, list) => {
  if (Array.isArray(list) && list.length) showSharePicker(list);
});

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
  // Re-assert the desktop marker here: the very first attempt (above) can run
  // before the <html> element exists, so make sure it is set once the DOM is
  // ready. All of the desktop-only CSS is scoped to html.hb-desktop.
  try { document.documentElement.classList.add('hb-desktop'); } catch (e) {}
  buildWindowControls();
  watchHeader();
}
if (document.body) boot();
else window.addEventListener('DOMContentLoaded', boot, { once: true });

// Keep the window controls at their true pixel size when the user changes the
// zoom (Ctrl +/- / Ctrl 0). main.js tells us the new factor.
ipcRenderer.on('zoom-changed', (e, z) => {
  const v = parseFloat(z);
  if (isFinite(v) && v > 0.1 && v <= 2) { setZoomVar(v); syncControlHeight(); }
});
