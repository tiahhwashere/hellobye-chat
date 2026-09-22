# Request BP — todo

## 1. Server profile avatar syncs to bottom-left footer
- [x] Make `renderSelfFooter()` prefer the server-scoped avatar (from `activeServer.members`) over the account avatar
- [x] Ensure it updates live after saving the My Server Profile editor (renderServerView now calls renderSelfFooter)
- [x] Verify in browser

## 2. Voice/audio messages use the custom player embed in the main chat
- [x] Port the `.voice-player` embed (waveform, play/pause, speed, download) into index.html
- [x] Use it for audio attachments in public chat, DMs and groupchats
- [x] Verify in browser

## 3. Deploy
- [x] Commit + push to master (a84f680)
- [x] Verify Render deploy live (dep-dapehg3ncjis73d5j6tg = live)
