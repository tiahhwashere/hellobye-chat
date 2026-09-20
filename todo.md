# Request AD — Auto-embed GIF links (Giphy etc.) in server chat

## 1. Root cause
- [x] Giphy returns 403 to server-side scrapers -> no og:image -> no embed
- [x] Tenor + direct .gif links already worked

## 2. Fix
- [x] server.js: add `giphyGifUrl()` helper (extract id from giphy.com/gifs, /media, /embed URLs)
- [x] server.js `/api/embed`: special-case Giphy -> return direct media.giphy.com GIF URL as gifUrl
- [x] Client already renders gifUrl as an inline animated GIF (no change needed)

## 3. Verify & Deploy
- [x] node --check server.js
- [x] Unit test: giphyGifUrl for all URL patterns
- [x] E2E test: /api/embed returns gifUrl for giphy + tenor + direct gif
- [x] Cleanup test file + restore data/db.json seed
- [x] Commit + push to GitHub master (873c754)
- [x] Trigger/verify Render deploy (live, no data wiped)
