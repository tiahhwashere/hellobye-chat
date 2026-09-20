# Request AE — Zoomed media should be bigger (fill the viewport)

## 1. Fix
- [x] `.image-lightbox-stage`: fixed `width:92vw; height:86vh` (was max-* only)
- [x] `.image-lightbox-stage img`: `width:100%; height:100%; object-fit:contain` so small media scales UP to fill the stage (no stretching)
- [x] Removed the full-stage box-shadow (looked odd when image fills the stage)

## 2. Verify & Deploy
- [x] node --check extracted servers.html script
- [x] Smoke test locally (servers.html 200, new CSS served)
- [ ] Commit + push to GitHub master
- [ ] Trigger/verify Render deploy (no data wiped)
