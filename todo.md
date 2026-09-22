# Request BO — todo

## 1. "In voice" indicator gated on status
- [x] Member list: only show "In voice — <channel>" when status is online/idle/dnd (hide for offline)
- [x] Member profile: same gating
- [x] Verify in browser

## 2. Media lightbox: click-off to close + remove X button
- [x] servers.html image lightbox: remove X close button (HTML + CSS)
- [x] servers.html video lightbox: remove X close button (HTML + CSS)
- [x] index.html image lightbox: remove X close button (HTML + CSS)
- [x] Ensure click-off (backdrop/stage) closes both lightboxes
- [x] Make message videos open in the lightbox (image/gif/video) with click-off + no X
- [x] Verify in browser

## 3. Screen share: show mouse cursor for all surfaces
- [x] Ensure cursor:'always' is applied for entire screen, window AND tab
- [x] Add synthetic cursor overlay fallback for window/tab shares
- [x] Verify code

## 4. Deploy
- [ ] Commit + push to master
- [ ] Verify Render deploy live
