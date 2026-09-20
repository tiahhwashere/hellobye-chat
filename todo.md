# Fix: GIF not showing inline in Servers (only visible when zoomed)

## Root cause
- [x] Confirmed: GIFs were rendered as `<video><source type="image/gif">`
- [x] Browsers cannot decode GIF in a `<video>` (networkState=3 NETWORK_NO_SOURCE, videoWidth=0) → blank inline
- [x] Lightbox uses `<img>` → GIF visible only when zoomed

## Fix
- [x] Render GIFs as native `<img class="msg-media msg-gif" data-zoom ...>` in `renderFile`
- [x] Keep `data-zoom`/`data-zoom-src` so click-to-zoom still works

## Verification
- [x] Syntax check passes
- [x] Browser test: GIF `<img>` naturalWidth=200, complete=true, zoomable
- [x] End-to-end: uploaded real animated GIF, sent via socket, rendered inline in channel

## Deploy
- [x] Commit + push to GitHub master
- [x] Render deploy live
- [x] Live site serves fixed renderFile
- [x] No data wiped (db.json at clean baseline)
