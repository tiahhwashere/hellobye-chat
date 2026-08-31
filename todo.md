# Round 6 — DM & Validation UI Improvements

## Setup / Investigation
- [x] Explore index.html + server.js to find relevant code sections
- [x] Find "Password is required." UI + its SVG (error toast icon, 5 calls)
- [x] Find "extra message space messages" = DM messages (.dm-messages bigger than .messages-container) — confirmed by user
- [x] Find DM message rendering (renderDMMessages/appendDMMessage) + X close button (dm-close-btn @7442)
- [x] Find existing Search Messages system (global panel + /api/search-messages scope=dms)

## Implementation
- [x] Fix 1: Remove the SVG from the "Password is required." UI (toast noIcon option)
- [x] Fix 2: Make DM messages small like normal public-chat messages
- [x] Fix 3: Add pin-messages system (header Pinned btn left of X + per-msg pin action + pinned list)
- [x] Fix 4: Add Search Messages button in DM header (left of X) scoped to current DM
- [x] Backend: persist pinned DM messages (db.users[me].dmPins) + dm-search-conversation endpoint

## Deploy
- [x] Syntax check (server.js + inline JS in index.html) — both pass node -c
- [x] Local boot test — server boots, / returns 200, new endpoints return 401 (auth-protected)
- [x] db.json untouched (md5 unchanged: 99761e4c34b3b0dd84d8952dfef8efd0, empty schema only)
- [ ] Commit + push to GitHub (auto-deploys via Render)
- [ ] Verify Render deploy live
- [ ] Confirm all features on live site
