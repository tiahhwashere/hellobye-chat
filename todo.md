# Request Y — Chat background persistence + golden mention highlight

## 1. Chat background survives refresh
- [x] Move `.server-chat-bg` out of `#server-messages` into a stable sibling layer (`#server-chat-body`)
- [x] Update `applyServerChatBackground()` to target the stable element
- [x] Persist last-opened server + channel (localStorage) and restore on boot

## 2. @everyone / @here red highlight -> darkish golden
- [x] `.msg-group.mention-ping` -> golden tint + golden left border
- [x] `.mention-toast` border -> golden

## 3. Verify & Deploy
- [x] node --check on server.js + extracted servers.html script
- [x] Smoke test locally (bg persistence via API verified)
- [ ] Commit + push to GitHub master
- [ ] Trigger/verify Render deploy (no data wiped)
