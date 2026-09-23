// Preload — runs inside the loaded HelloBye page. It exposes a tiny, safe
// bridge to the renderer AND injects the "soft update" banner UI so the user
// sees a native-feeling prompt when the website has been updated.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hellobyeDesktop', {
  isDesktop: true,
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('app-version'),
  checkForUpdate: () => ipcRenderer.invoke('check-update-now'),
  applyUpdate: () => ipcRenderer.send('apply-update'),
  dismissUpdate: () => ipcRenderer.send('dismiss-update'),
  menuAction: (action) => ipcRenderer.send('menu-action', action),
  onSoftUpdate: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('soft-update-available', () => cb());
  },
});

// ---- Soft-update banner (injected into the page) ----
function injectStyles() {
  if (document.getElementById('hb-desktop-update-style')) return;
  const style = document.createElement('style');
  style.id = 'hb-desktop-update-style';
  style.textContent = `
    #hb-desktop-update {
      position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%) translateY(140%);
      z-index: 2147483647; display: flex; align-items: stretch; overflow: hidden;
      padding: 0; border-radius: 14px; max-width: min(560px, 92vw);
      background: linear-gradient(180deg, rgba(34,36,43,0.98), rgba(19,20,25,0.98));
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 18px 50px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.4);
      color: #e9eaee; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      opacity: 0; transition: transform .35s cubic-bezier(.2,.9,.3,1.2), opacity .35s ease;
      pointer-events: none;
    }
    #hb-desktop-update.show { transform: translateX(-50%) translateY(0); opacity: 1; pointer-events: auto; }
    #hb-desktop-update .hb-accent {
      flex: 0 0 auto; width: 4px; background: linear-gradient(180deg, #8b93ff, #5865f2);
    }
    #hb-desktop-update .hb-body { min-width: 0; flex: 1 1 auto; padding: 15px 18px 17px; display: flex; flex-direction: column; gap: 7px; }
    #hb-desktop-update .hb-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    #hb-desktop-update .hb-title { font-weight: 800; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: #8b93ff; }
    #hb-desktop-update .hb-text { font-size: 13.5px; color: #a9abb3; line-height: 1.55; }
    #hb-desktop-update .hb-actions { display: flex; gap: 8px; flex: 0 0 auto; }
    #hb-desktop-update button {
      font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
      border-radius: 9px; padding: 8px 13px; border: 1px solid transparent; transition: filter .15s ease, background .15s ease;
    }
    #hb-desktop-update .hb-update { background: #5865f2; color: #fff; }
    #hb-desktop-update .hb-update:hover { filter: brightness(1.1); }
    #hb-desktop-update .hb-later { background: transparent; color: #c7c9d1; border-color: rgba(255,255,255,0.14); }
    #hb-desktop-update .hb-later:hover { background: rgba(255,255,255,0.06); }
    #hb-desktop-update .hb-progress {
      position: absolute; left: 0; bottom: 0; height: 3px; width: 100%; border-radius: 0 0 14px 14px;
      background: linear-gradient(90deg, #5865f2, #8b93ff); transform-origin: left; transform: scaleX(1);
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

let bannerEl = null;
let countdownTimer = null;
const COUNTDOWN = 20;

function showBanner() {
  injectStyles();
  if (bannerEl) { bannerEl.classList.add('show'); return; }
  bannerEl = document.createElement('div');
  bannerEl.id = 'hb-desktop-update';
  bannerEl.innerHTML =
    '<span class="hb-accent"></span>' +
    '<div class="hb-body">' +
      '<div class="hb-head">' +
        '<div class="hb-title">Update available</div>' +
      '</div>' +
      '<div class="hb-text">A new version of HelloBye is ready. It will update automatically in <b id="hb-count">' + COUNTDOWN + '</b>s. Your login and data are kept.</div>' +
      '<div class="hb-actions">' +
        '<button class="hb-later" id="hb-later" type="button">Later</button>' +
        '<button class="hb-update" id="hb-update" type="button">Update now</button>' +
      '</div>' +
    '</div>' +
    '<span class="hb-progress" id="hb-progress"></span>';
  document.body.appendChild(bannerEl);
  requestAnimationFrame(() => bannerEl.classList.add('show'));

  const prog = bannerEl.querySelector('#hb-progress');
  if (prog) {
    prog.style.transition = 'transform ' + COUNTDOWN + 's linear';
    requestAnimationFrame(() => { prog.style.transform = 'scaleX(0)'; });
  }
  bannerEl.querySelector('#hb-update').addEventListener('click', doUpdate);
  bannerEl.querySelector('#hb-later').addEventListener('click', () => {
    clearInterval(countdownTimer);
    ipcRenderer.send('dismiss-update');
    if (bannerEl) bannerEl.classList.remove('show');
  });

  let remaining = COUNTDOWN;
  const cd = bannerEl.querySelector('#hb-count');
  countdownTimer = setInterval(() => {
    remaining -= 1;
    if (cd) cd.textContent = String(Math.max(0, remaining));
    if (remaining <= 0) { clearInterval(countdownTimer); doUpdate(); }
  }, 1000);
}

function doUpdate() {
  clearInterval(countdownTimer);
  ipcRenderer.send('apply-update');
}

ipcRenderer.on('soft-update-available', () => {
  if (document.body) showBanner();
  else window.addEventListener('DOMContentLoaded', showBanner, { once: true });
});

// ============================================================
// Custom in-app menu bar (File / View / Help)
// ------------------------------------------------------------
// The native Electron menu is disabled (see main.js). Instead we draw our own
// menu bar that matches the site's dark UI, with custom dropdowns. There is
// intentionally NO "Edit" menu and NO "Toggle Developer Tools" entry.
// ============================================================
function injectMenuStyles() {
  if (document.getElementById('hb-desktop-menu-style')) return;
  const style = document.createElement('style');
  style.id = 'hb-desktop-menu-style';
  style.textContent = `
    #hb-menubar {
      position: fixed; top: 0; left: 0; right: 0; height: 34px; z-index: 2147483000;
      display: flex; align-items: center; gap: 2px; padding: 0 8px;
      background: #16171a; border-bottom: 1px solid rgba(255,255,255,0.07);
      color: #d7d9e0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      font-size: 13px; user-select: none; -webkit-app-region: drag;
    }
    #hb-menubar .hb-mb-brand {
      display: flex; align-items: center; gap: 7px; font-weight: 700; letter-spacing: .2px;
      color: #fff; padding: 0 10px 0 4px; margin-right: 4px;
    }
    #hb-menubar .hb-mb-brand .hb-mb-dot {
      width: 16px; height: 16px; border-radius: 5px;
      background: linear-gradient(135deg, #5865f2, #8b93ff);
      box-shadow: 0 0 10px rgba(88,101,242,.5);
    }
    #hb-menubar .hb-mb-item {
      -webkit-app-region: no-drag;
      position: relative; padding: 5px 11px; border-radius: 7px; cursor: pointer;
      color: #c7c9d1; transition: background .12s ease, color .12s ease;
    }
    #hb-menubar .hb-mb-item:hover, #hb-menubar .hb-mb-item.open { background: rgba(255,255,255,0.09); color: #fff; }
    #hb-menubar .hb-mb-spacer { flex: 1 1 auto; }
    #hb-menubar .hb-mb-ver { -webkit-app-region: no-drag; color: #6d7078; font-size: 11.5px; padding-right: 6px; }
    .hb-mb-drop {
      position: fixed; z-index: 2147483001; min-width: 210px; padding: 6px;
      background: #1e1f23; border: 1px solid rgba(255,255,255,0.10); border-radius: 11px;
      box-shadow: 0 16px 44px rgba(0,0,0,0.55); color: #e6e7ec;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 13px;
      opacity: 0; transform: translateY(-6px); transition: opacity .12s ease, transform .12s ease;
      pointer-events: none;
    }
    .hb-mb-drop.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
    .hb-mb-drop .hb-mb-row {
      display: flex; align-items: center; justify-content: space-between; gap: 18px;
      padding: 8px 11px; border-radius: 8px; cursor: pointer; color: #d7d9e0;
    }
    .hb-mb-drop .hb-mb-row:hover { background: #5865f2; color: #fff; }
    .hb-mb-drop .hb-mb-row .hb-mb-acc { color: #8a8d96; font-size: 11.5px; }
    .hb-mb-drop .hb-mb-row:hover .hb-mb-acc { color: rgba(255,255,255,0.8); }
    .hb-mb-drop .hb-mb-sep { height: 1px; margin: 5px 8px; background: rgba(255,255,255,0.08); }
    body.hb-has-menubar #servers-app { height: calc(100vh - 34px) !important; margin-top: 34px; }
    body.hb-has-menubar #chat-app { height: calc(100vh - 34px) !important; margin-top: 34px; }
    @supports (height: 100dvh) {
      body.hb-has-menubar #servers-app { height: calc(100dvh - 34px) !important; }
      body.hb-has-menubar #chat-app { height: calc(100dvh - 34px) !important; }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

let openDrop = null;
function closeDrop() {
  if (openDrop) { openDrop.classList.remove('show'); openDrop = null; }
  document.querySelectorAll('#hb-menubar .hb-mb-item.open').forEach(el => el.classList.remove('open'));
}

function buildMenuBar() {
  if (document.getElementById('hb-menubar')) return;
  injectMenuStyles();

  const menus = {
    File: [
      { label: 'Reload', acc: 'Ctrl+R', action: 'reload' },
      { label: 'Check for updates', action: 'check-updates' },
      { sep: true },
      { label: 'Quit Hellobye', acc: 'Alt+F4', action: 'quit' },
    ],
    View: [
      { label: 'Reset zoom', acc: 'Ctrl+0', action: 'zoom-reset' },
      { label: 'Zoom in', acc: 'Ctrl++', action: 'zoom-in' },
      { label: 'Zoom out', acc: 'Ctrl+-', action: 'zoom-out' },
      { sep: true },
      { label: 'Toggle full screen', acc: 'F11', action: 'fullscreen' },
    ],
    Help: [
      { label: 'Hellobye website', action: 'website' },
      { label: 'About Hellobye', action: 'about' },
    ],
  };

  const bar = document.createElement('div');
  bar.id = 'hb-menubar';
  bar.innerHTML = '<div class="hb-mb-brand"><span class="hb-mb-dot"></span>Hellobye</div>';
  Object.keys(menus).forEach((name) => {
    const item = document.createElement('div');
    item.className = 'hb-mb-item';
    item.textContent = name;
    item.dataset.menu = name;
    bar.appendChild(item);
  });
  const spacer = document.createElement('div'); spacer.className = 'hb-mb-spacer'; bar.appendChild(spacer);
  const ver = document.createElement('div'); ver.className = 'hb-mb-ver'; ver.id = 'hb-mb-ver'; bar.appendChild(ver);
  document.body.appendChild(bar);
  document.body.classList.add('hb-has-menubar');

  // Fill in the app version asynchronously.
  try {
    ipcRenderer.invoke('app-version').then((v) => { if (v) ver.textContent = 'v' + v; }).catch(() => {});
  } catch (e) {}

  bar.querySelectorAll('.hb-mb-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = item.dataset.menu;
      const wasOpen = item.classList.contains('open');
      closeDrop();
      if (wasOpen) return;
      item.classList.add('open');
      const drop = document.createElement('div');
      drop.className = 'hb-mb-drop';
      (menus[name] || []).forEach((row) => {
        if (row.sep) { const s = document.createElement('div'); s.className = 'hb-mb-sep'; drop.appendChild(s); return; }
        const r = document.createElement('div');
        r.className = 'hb-mb-row';
        r.innerHTML = '<span>' + row.label + '</span>' + (row.acc ? '<span class="hb-mb-acc">' + row.acc + '</span>' : '');
        r.addEventListener('click', (ev) => { ev.stopPropagation(); closeDrop(); ipcRenderer.send('menu-action', row.action); });
        drop.appendChild(r);
      });
      document.body.appendChild(drop);
      const rect = item.getBoundingClientRect();
      drop.style.left = Math.round(rect.left) + 'px';
      drop.style.top = Math.round(rect.bottom + 4) + 'px';
      requestAnimationFrame(() => drop.classList.add('show'));
      openDrop = drop;
    });
  });

  document.addEventListener('click', closeDrop);
  window.addEventListener('blur', closeDrop);
  window.addEventListener('resize', closeDrop);
}

if (document.body) buildMenuBar();
else window.addEventListener('DOMContentLoaded', buildMenuBar, { once: true });
