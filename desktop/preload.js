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
      z-index: 2147483647; display: flex; align-items: center; gap: 14px;
      padding: 14px 16px; border-radius: 14px; max-width: min(560px, 92vw);
      background: linear-gradient(180deg, #232428, #1b1c1f);
      border: 1px solid rgba(255,255,255,0.10);
      box-shadow: 0 18px 50px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.4);
      color: #e9eaee; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      opacity: 0; transition: transform .35s cubic-bezier(.2,.9,.3,1.2), opacity .35s ease;
      pointer-events: none;
    }
    #hb-desktop-update.show { transform: translateX(-50%) translateY(0); opacity: 1; pointer-events: auto; }
    #hb-desktop-update .hb-ic {
      flex: 0 0 auto; width: 40px; height: 40px; border-radius: 11px; display: grid; place-items: center;
      background: rgba(88,101,242,0.16); color: #8b93ff;
    }
    #hb-desktop-update .hb-ic svg { width: 22px; height: 22px; }
    #hb-desktop-update .hb-body { min-width: 0; flex: 1 1 auto; }
    #hb-desktop-update .hb-title { font-weight: 700; font-size: 14px; margin-bottom: 2px; }
    #hb-desktop-update .hb-text { font-size: 12.5px; color: #a9abb3; line-height: 1.35; }
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
    '<span class="hb-ic">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>' +
    '</span>' +
    '<div class="hb-body">' +
      '<div class="hb-title">A new update is available</div>' +
      '<div class="hb-text">HelloBye will update automatically in <b id="hb-count">' + COUNTDOWN + '</b>s. Your login and data are kept.</div>' +
    '</div>' +
    '<div class="hb-actions">' +
      '<button class="hb-later" id="hb-later" type="button">Later</button>' +
      '<button class="hb-update" id="hb-update" type="button">Update now</button>' +
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
