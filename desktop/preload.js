const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hellobyeDesktop', {
  isDesktop: true,
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('app-version'),
  getLastLogin: () => ipcRenderer.invoke('get-last-login'),
  saveLastLogin: (data) => ipcRenderer.send('save-last-login', data),
  clearLastLogin: () => ipcRenderer.send('clear-last-login'),
  checkForUpdate: () => ipcRenderer.invoke('check-update-now'),
  downloadNewBuild: () => ipcRenderer.send('download-new-build'),
  dismissUpdate: () => ipcRenderer.send('dismiss-update'),
  minimize: () => ipcRenderer.send('window-minimize'),
  maximizeToggle: () => ipcRenderer.send('window-maximize-toggle'),
  close: () => ipcRenderer.send('window-close'),
  toggleFullscreen: () => ipcRenderer.send('window-toggle-fullscreen'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  isFullscreen: () => ipcRenderer.invoke('window-is-fullscreen'),
  onMaximized: (cb) => { if (typeof cb === 'function') ipcRenderer.on('window-maximized', (e, v) => cb(!!v)); },
  onSoftUpdate: (cb) => { if (typeof cb === 'function') ipcRenderer.on('soft-update-available', () => cb()); },
  onDisplaySources: (cb) => { if (typeof cb === 'function') ipcRenderer.on('display-sources', (e, list) => cb(list)); },
  pickDisplaySource: (id) => ipcRenderer.send('display-source-pick', id),
  cancelDisplaySource: () => ipcRenderer.send('display-source-cancel'),
});

try { document.documentElement.classList.add('hb-desktop'); } catch (e) {}

const WC_BTN_W = 46;
const WC_H = 40;

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

function activeHeader() {
  return document.querySelector('.server-chat-header') ||
         document.querySelector('.chat-header') ||
         document.querySelector('.sidebar-header');
}
function syncControlHeight() {
  try {
    const hdr = activeHeader();
    if (!hdr) return;
    const h = hdr.getBoundingClientRect().height;
    if (h > 0) document.documentElement.style.setProperty('--hb-wc-h', h + 'px');
  } catch (e) {}
}

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

function injectUpdateStyles() {
  if (document.getElementById('hb-update-style')) return;
  const style = document.createElement('style');
  style.id = 'hb-update-style';
  style.textContent = `
    #hb-update-overlay {
      position: fixed; inset: 0; z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
      background:
        radial-gradient(1200px 720px at 50% -12%, rgba(88,101,242,0.20), transparent 62%),
        radial-gradient(900px 640px at 108% 116%, rgba(139,147,255,0.13), transparent 62%),
        radial-gradient(760px 560px at -8% 108%, rgba(88,101,242,0.10), transparent 60%),
        rgba(5,6,9,0.82);
      -webkit-backdrop-filter: blur(12px) saturate(1.15); backdrop-filter: blur(12px) saturate(1.15);
      opacity: 0; pointer-events: none; transition: opacity .24s ease;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    #hb-update-overlay.show { opacity: 1; pointer-events: auto; }
    #hb-update-card {
      position: relative; isolation: isolate; overflow: hidden;
      width: min(540px, calc(100vw - 48px));
      background: #0d0e12;
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 22px;
      box-shadow: 0 44px 130px rgba(0,0,0,0.72), 0 0 0 1px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05);
      color: #e9eaee;
      transform: translateY(20px) scale(0.95);
      transition: transform .36s cubic-bezier(.2,.9,.3,1.15);
    }
    #hb-update-overlay.show #hb-update-card { transform: translateY(0) scale(1); }
    /* Layer 1 — slow-drifting accent aurora mesh */
    #hb-update-card::before {
      content: ''; position: absolute; inset: -45%; z-index: -2;
      background:
        radial-gradient(38% 38% at 24% 26%, rgba(88,101,242,0.58), transparent 70%),
        radial-gradient(34% 34% at 80% 28%, rgba(139,147,255,0.42), transparent 72%),
        radial-gradient(46% 46% at 56% 90%, rgba(88,101,242,0.44), transparent 74%);
      filter: blur(46px) saturate(1.25);
      animation: hb-up-drift 20s ease-in-out infinite alternate;
    }
    /* Layer 2 — fine engineering grid, faded toward the edges */
    #hb-update-card::after {
      content: ''; position: absolute; inset: 0; z-index: -1; opacity: .5;
      background-image:
        linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px);
      background-size: 34px 34px;
      -webkit-mask-image: radial-gradient(125% 95% at 50% 0%, #000 18%, transparent 82%);
      mask-image: radial-gradient(125% 95% at 50% 0%, #000 18%, transparent 82%);
    }
    @keyframes hb-up-drift { 0% { transform: translate3d(-4%,-3%,0) scale(1.06); } 100% { transform: translate3d(4%,3%,0) scale(1.16); } }
    #hb-update-card .hb-up-accent { position: relative; z-index: 3; height: 3px; width: 100%; background: linear-gradient(90deg, #5865f2, #8b93ff, #5865f2); background-size: 200% 100%; animation: hb-up-sheen 6s linear infinite; }
    @keyframes hb-up-sheen { to { background-position: 200% 0; } }
    #hb-update-card .hb-up-body {
      position: relative; z-index: 2; padding: 30px 30px 26px; text-align: center;
      background: linear-gradient(180deg, rgba(12,13,17,0.30), rgba(11,12,15,0.80) 62%);
    }
    #hb-update-card .hb-up-pill {
      display: inline-flex; align-items: center; gap: 8px; margin-bottom: 16px;
      padding: 6px 14px; border-radius: 999px;
      font-size: 10.5px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase;
      color: #c7cbff; background: rgba(88,101,242,0.14);
      border: 1px solid rgba(139,147,255,0.34);
    }
    #hb-update-card .hb-up-pill .hb-up-dot { width: 7px; height: 7px; border-radius: 50%; background: #8b93ff; box-shadow: 0 0 10px rgba(139,147,255,0.9); animation: hb-up-pulse 1.9s ease-in-out infinite; }
    @keyframes hb-up-pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
    #hb-update-card .hb-up-title { font-size: 23px; font-weight: 800; letter-spacing: -.01em; color: #fff; margin-bottom: 10px; }
    #hb-update-card .hb-up-text { font-size: 13.5px; color: #a9abb3; line-height: 1.65; margin-bottom: 10px; }
    #hb-update-card .hb-up-text b { color: #c9ccff; font-weight: 700; }
    #hb-update-card .hb-up-ver { font-size: 11.5px; color: #8a8d96; margin-bottom: 22px; }
    #hb-update-card .hb-up-actions { display: flex; flex-direction: column; gap: 10px; }
    #hb-update-card button {
      font: inherit; font-size: 14px; font-weight: 700; cursor: pointer;
      border-radius: 12px; padding: 14px 16px; border: 1px solid transparent;
      transition: filter .15s ease, background .15s ease, opacity .15s ease, transform .15s ease;
    }
    #hb-update-card .hb-up-download { background: linear-gradient(180deg, #6b76f5, #5865f2); color: #fff; box-shadow: 0 10px 26px rgba(88,101,242,0.42); }
    #hb-update-card .hb-up-download:hover { filter: brightness(1.08); transform: translateY(-1px); }
    #hb-update-card .hb-up-later { background: rgba(255,255,255,0.04); color: #c7c9d1; border-color: rgba(255,255,255,0.14); }
    #hb-update-card .hb-up-later:hover { background: rgba(255,255,255,0.08); }
    #hb-update-card .hb-up-note { margin-top: 15px; font-size: 11px; color: #7c7f88; line-height: 1.55; }
    #hb-update-card .hb-up-progress { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; height: 3px; background: rgba(255,255,255,0.06); opacity: 0; transition: opacity .2s ease; overflow: hidden; }
    #hb-update-card .hb-up-progress::after { content: ''; position: absolute; top: 0; bottom: 0; width: 42%; background: linear-gradient(90deg, transparent, #8b93ff, transparent); animation: hb-up-slide 1.15s linear infinite; }
    @keyframes hb-up-slide { from { transform: translateX(-130%); } to { transform: translateX(330%); } }
    #hb-update-overlay.working .hb-up-actions { opacity: .5; pointer-events: none; }
    #hb-update-overlay.working .hb-up-progress { opacity: 1; }
    @media (prefers-reduced-motion: reduce) {
      #hb-update-card::before, #hb-update-card .hb-up-accent,
      #hb-update-card .hb-up-pill .hb-up-dot, #hb-update-card .hb-up-progress::after { animation: none; }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

let updateOverlayEl = null;

function showUpdateModal() {
  injectUpdateStyles();
  if (updateOverlayEl) { updateOverlayEl.classList.add('show'); return; }

  updateOverlayEl = document.createElement('div');
  updateOverlayEl.id = 'hb-update-overlay';
  updateOverlayEl.innerHTML =
    '<div id="hb-update-card" role="dialog" aria-modal="true" aria-labelledby="hb-up-title">' +
      '<div class="hb-up-accent"></div>' +
      '<div class="hb-up-body">' +
        '<div class="hb-up-pill"><span class="hb-up-dot"></span>Update available</div>' +
        '<div class="hb-up-title" id="hb-up-title">A new build is ready</div>' +
        '<div class="hb-up-text">A newer version of <b>Hellobye for PC</b> is available. Download the latest build to pick up the newest fixes and features.</div>' +
        '<div class="hb-up-ver" id="hb-up-ver">Hellobye for PC</div>' +
        '<div class="hb-up-actions">' +
          '<button class="hb-up-download" id="hb-up-download" type="button">Install update</button>' +
          '<button class="hb-up-later" id="hb-up-later" type="button">Later</button>' +
        '</div>' +
        '<div class="hb-up-note">Installing removes the whole Hellobye app from this PC, then opens the download page so you can install the fresh build.</div>' +
      '</div>' +
      '<div class="hb-up-progress"></div>' +
    '</div>';
  document.body.appendChild(updateOverlayEl);
  requestAnimationFrame(() => updateOverlayEl.classList.add('show'));

  try {
    ipcRenderer.invoke('app-version').then((v) => {
      const el = updateOverlayEl && updateOverlayEl.querySelector('#hb-up-ver');
      if (el && v) el.textContent = 'Currently installed: v' + v;
    }).catch(() => {});
  } catch (e) {}

  updateOverlayEl.querySelector('#hb-up-download').addEventListener('click', doDownload);
  updateOverlayEl.querySelector('#hb-up-later').addEventListener('click', () => {
    ipcRenderer.send('dismiss-update');
    if (updateOverlayEl) updateOverlayEl.classList.remove('show');
    // The user deferred the update — drop a small download shortcut into the
    // chat header so they can install later without waiting for another prompt.
    wantUpdateIcon();
  });
}

/* ---- Deferred-update download shortcut ----------------------------------
   When the user taps "Later" on the update prompt we place a small download
   icon just to the left of the "Search messages" button in the chat header.
   Clicking it runs the exact same self-delete + redirect flow as the normal
   "Install update" action. */
function updateIconStyles() {
  if (document.getElementById('hb-up-icon-style')) return;
  const st = document.createElement('style');
  st.id = 'hb-up-icon-style';
  st.textContent =
    '#hb-update-icon-btn{position:relative;color:#8b93ff !important;}' +
    '#hb-update-icon-btn:hover{color:#aab1ff !important;}' +
    '#hb-update-icon-btn::after{content:"";position:absolute;top:4px;right:4px;width:7px;height:7px;border-radius:50%;' +
    '  background:#5865f2;box-shadow:0 0 0 2px rgba(0,0,0,0.35),0 0 8px rgba(88,101,242,0.95);animation:hbUpIconPulse 1.9s ease-in-out infinite;}' +
    '@keyframes hbUpIconPulse{0%,100%{opacity:.5}50%{opacity:1}}';
  (document.head || document.documentElement).appendChild(st);
}

function injectUpdateIcon() {
  try {
    if (document.getElementById('hb-update-icon-btn')) return;
    const searchBtn = document.getElementById('search-msg-btn');
    if (!searchBtn || !searchBtn.parentNode) return;
    updateIconStyles();
    const btn = document.createElement('button');
    btn.id = 'hb-update-icon-btn';
    btn.className = 'icon-btn';
    btn.type = 'button';
    btn.title = 'Update available \u2014 click to install the new build';
    btn.setAttribute('aria-label', 'Install update');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3v10.5"/><polyline points="7.6 9.6 12 14 16.4 9.6"/><line x1="5" y1="19.5" x2="19" y2="19.5"/></svg>';
    btn.addEventListener('click', doDownload);
    searchBtn.parentNode.insertBefore(btn, searchBtn);
  } catch (e) {}
}

let updateIconWanted = false;
function wantUpdateIcon() {
  updateIconWanted = true;
  try { localStorage.setItem('hb_update_icon', '1'); } catch (e) {}
  injectUpdateIcon();
}
function clearUpdateIcon() {
  updateIconWanted = false;
  try { localStorage.removeItem('hb_update_icon'); } catch (e) {}
  const b = document.getElementById('hb-update-icon-btn');
  if (b) b.remove();
}

function doDownload() {
  if (updateOverlayEl) {
    updateOverlayEl.classList.add('working');
    const t = updateOverlayEl.querySelector('.hb-up-title');
    const x = updateOverlayEl.querySelector('.hb-up-text');
    if (t) t.textContent = 'Installing update\u2026';
    if (x) x.textContent = 'Removing the whole Hellobye app from this PC, then opening the download page in your browser.';
  }
  try { window.dispatchEvent(new Event('hb-persist-carryover')); } catch (e) {}
  setTimeout(() => ipcRenderer.send('download-new-build'), 300);
}

ipcRenderer.on('soft-update-available', () => {
  if (document.body) showUpdateModal();
  else window.addEventListener('DOMContentLoaded', showUpdateModal, { once: true });
});

document.addEventListener('dragstart', (e) => {
  const t = e.target;
  if (t && t.tagName === 'IMG') e.preventDefault();
});

function boot() {
  try { document.documentElement.classList.add('hb-desktop'); } catch (e) {}
  buildWindowControls();
  watchHeader();
  // If the user deferred an update earlier, keep the download shortcut visible.
  try { if (localStorage.getItem('hb_update_icon') === '1') { updateIconWanted = true; injectUpdateIcon(); } } catch (e) {}
  try {
    const mo = new MutationObserver(() => { if (updateIconWanted) injectUpdateIcon(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
}
if (document.body) boot();
else window.addEventListener('DOMContentLoaded', boot, { once: true });

ipcRenderer.on('zoom-changed', (e, z) => {
  const v = parseFloat(z);
  if (isFinite(v) && v > 0.1 && v <= 2) { setZoomVar(v); syncControlHeight(); }
});
