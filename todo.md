# Request AB — Chat Background image quality: clearer, not staticy/buggy

## 1. Root cause
- [x] Identified: chat-background upload ran the enhance pipeline with an aggressive sharpen pass (sigma 0.6, m2 3) after Lanczos3 upscale -> amplifies compression noise on smooth regions = "staticy" look

## 2. Fix
- [x] enhance.js: add `noSharpen` option to skip the sharpen pass
- [x] server.js chat-background endpoint: `noSharpen: true` + raise target to 2560px (crisp, smooth)
- [x] Confirm no CSS noise/grain overlays exist

## 3. Verify & Deploy
- [x] node --check enhance.js + server.js
- [x] Pipeline test: no-sharpen output is clean/smooth (smaller file = less noise)
- [x] Smoke test locally (servers.html 200)
- [x] Commit + push to GitHub master (67a0ce4)
- [x] Trigger/verify Render deploy (live, no data wiped)
