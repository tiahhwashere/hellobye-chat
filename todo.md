# Round 22 — Admin spacing, avatar unsaved-guard, search anim, clear activity, unfriend confirm, conversation context menu, bigger messages

## Tasks

### A. Administrator Panel — more spacing (ban reason, logs, systems)
- [x] 1. Add spacing/padding to admin sections, ban form, account rows, activity items

### B. Profile picture removal — unsaved-changes guard (like banner)
- [x] 2. avatar-remove-btn: local-only preview, pendingAvatarRemoval flag, markProfileDirty
- [x] 3. saveProfileNow: commit pending avatar removal on Save
- [x] 4. captureSavedProfileImages + uploadProfileImage: reset pendingAvatarRemoval
- [x] 5. Discard reverts avatar via existing revert-image logic

### C. Search Messages UI — better slide animation
- [x] 6. Improve slideIn/slideOut animation (smoother, more polished)

### D. Recent Admin Activity — Clear button
- [x] 7. server.js: POST /api/admin/clear-activity endpoint
- [x] 8. index.html: add Clear button + handler, re-render after clear

### E. Remove Friend — confirmation button
- [x] 9. removeFriend: wrap in confirm modal before unfriending

### F. Chatroom members list context menu — Open/Close Conversation
- [x] 10. Add Open/Close Conversation options to members list right-click menu

### G. Message box — bigger text + wider/longer bubble
- [x] 11. Increase message-bubble font-size, max-width, padding for chatroom + DMs

### H. Deploy
- [x] 12. Syntax-check index.html + server.js
- [ ] 13. Commit + push (Render autoDeploy)
- [ ] 14. Verify live + no data wipe
