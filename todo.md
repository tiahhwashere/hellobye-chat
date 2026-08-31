# Round 5 — 5 Fixes

## Setup / Investigation
- [x] Fix 1: "This Profile is Private" UI — make right edge align (not stick out), tighten spacing
- [x] Fix 2: Compact message mode — make it actually affect message layout + lower the messages
- [x] Fix 3: Chat typing space + paste line breaks — smaller max-height, don't take half the screen
- [x] Fix 4: Fix uploading-on-send loading bar
- [x] Fix 5: Spoiler re-shows on images/screenshots every 5 minutes

## Implementation
- [x] Fix 1 implemented
- [x] Fix 2 implemented (incl. continuation grouping for all 3 chats)
- [x] Fix 3 implemented
- [x] Fix 4 implemented
- [x] Fix 5 implemented

## Deploy
- [x] Syntax check (server.js + inline JS)
- [x] Local boot test
- [x] db.json untouched
- [x] Clean up helper scripts
- [ ] Commit + push
- [ ] Verify Render deploy live
- [ ] Verify all fixes on live site
- [ ] Confirm no data removed
