# Request D — Todo

## Part 1: De-cramp "Voice chat background" + "Effect" pickers (servers.html)
- [x] Widen `.fx-card` grid (both #set-effect-seg and #vs-bg-seg)
- [x] Increase `.fx-card-preview` height + card padding/gap
- [x] Ensure labels fit; verify visually

## Part 2: Revamp PC soft-update UI (desktop/preload.js) — centered, richer bg, NO emojis/SVG
- [x] Remove `.hb-up-icon` download SVG entirely
- [x] New centered card with richer animated background
- [x] Verify visually via Electron screenshot

## Part 3: PC update flow — delete FULL app + redirect to /download (desktop/main.js)
- [x] Update DOWNLOAD_URL to https://hellobye-chat.onrender.com/download
- [x] Ensure scheduleSelfDelete removes full app (install dir + userData + shortcuts)
- [x] Verify logic

## Part 4: Revamp "Get HelloBye for PC" (download.html) — remove ALL emojis/SVG
- [x] Remove 4 .feat SVGs + .dl button SVG
- [x] Redesign layout without icons
- [x] Verify visually

## Ship
- [ ] Bump desktop 1.5.5 -> 1.5.6
- [ ] Build NSIS + portable
- [ ] Publish GitHub release desktop-v1.5.6 + upload assets
- [ ] Update server.js DESKTOP_FALLBACK + download.html to v1.5.6
- [ ] Commit + push; verify Render deploy + live endpoints
