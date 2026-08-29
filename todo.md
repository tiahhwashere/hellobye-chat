# Round 19 Todo

## Sub-tasks
- [x] 1. Change "DM user" → "Send Message" in chatroom context menus (DONE)
- [x] 2. Fix PC sidebar toggle: members background image STILL reverts — fixed by giving .members-bg-layer a FIXED width (300px desktop / 260px tablet / 280px mobile) instead of left:0;right:0 so it doesn't shrink during collapse animation
- [x] 3. Simplify admin panel description text (DONE — "Manage users, roles, badges, bans & whitelist. Owner: @lore")
- [x] 4. Add even more modern and better website notifications (DONE — redesigned toasts, in-app notif cards, and system alerts with glassmorphism, gradient accent bars, rounded icon backgrounds, blur+saturate, hover lift, smoother scale animations)
- [x] 5. Display Name change: add a 5-second cooldown (DONE — server-side enforcement with 429 + client-side live countdown button "Wait 5s...4s...3s")
- [x] 6. Better user reply/pinging systems (DONE — reply quote avatar+jump icon, reply preview avatar for both chat+DM, DM reply avatar+displayName, mention hover tooltip with status dot, distinct two-tone ping sound on mention, Escape-to-cancel-reply keyboard shortcut, consolidated reply-quote CSS)
- [x] 7. Syntax-check all script blocks (index.html + server.js) — DONE, all pass
- [ ] 8. Commit + push to GitHub master
- [ ] 9. Verify Render auto-deploy goes live
- [ ] 10. Verify site online (no data wipe) + edits grep-confirmed live
