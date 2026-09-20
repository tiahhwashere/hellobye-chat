# Feature: Auto-embed GIF links in Servers

## Backend (server.js)
- [x] `/api/embed`: detect direct GIF (content-type gif or .gif path) → return `gifUrl`
- [x] HTML branch: surface `gifUrl` when path ends in .gif
- [x] Catch/fallback: still return `gifUrl` for .gif URLs on fetch failure

## Frontend (servers.html)
- [x] `linkify`: `.gif` URLs render the animated GIF inline (with GIF badge + data-zoom)
- [x] `renderEmbed`: render inline GIF when backend returns `gifUrl` or a GIF og:image
- [x] CSS: `.link-embed-gif` + transparent wrapper for GIF embeds; mobile rules

## Verification
- [x] Syntax check passes (server.js + servers.html)
- [x] `/api/embed` returns gifUrl for giphy .gif URL
- [x] Browser: GIF link renders inline (naturalWidth 478, complete, zoomable, badge)
- [x] Click-to-zoom works on embedded GIF
- [x] renderEmbed gifUrl path renders inline GIF

## Deploy
- [x] Commit + push to GitHub master
- [x] Render deploy live
- [x] Live site serves new linkify/renderEmbed
- [x] No data wiped (db.json at clean baseline)
