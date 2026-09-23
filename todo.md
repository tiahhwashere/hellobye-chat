# HelloBye PC v1.5.1 — Servers page window-control overlap fix

## 1. Fix overlap on servers page (PC only)
- [x] Add `.server-chat-header` to padding-right rule (clear sch-actions buttons)
- [x] Add `.server-chat-header` to drag region + its buttons to no-drag
- [x] Add `.server-header-top` no-drag (banner is clickable)
- [x] Add syncControlHeight() + watchHeader() to match control height to header
- [x] Verify horizontal gap (no overlap) via DOM measurement
- [x] Verify vertical alignment (control height == header height)
- [x] Check modals for top-right close-button conflicts (none — centered overlays, z-index 1000)

## 2. Version bump to 1.5.1
- [x] desktop/package.json -> 1.5.1
- [x] server.js DESKTOP_FALLBACK -> 1.5.1
- [x] download.html static link + version label -> 1.5.1

## 3. Cleanup temp files
- [x] Delete test-servers2.js, test-chat.js, test-server.py
- [x] Kill stub server on port 8791

## 4. Build desktop v1.5.1
- [x] Build Windows NSIS + portable with electron-builder (Setup 78,224,545 B; Portable 77,969,237 B)

## 5. Publish GitHub release desktop-v1.5.1
- [x] Create release + upload Setup.exe + Portable.exe (release id 395150390)

## 6. Deploy
- [ ] Commit + push to master (Render auto-deploy)
- [ ] Verify live /api/desktop-release + download page show v1.5.1
- [ ] Send new download link
