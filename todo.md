# Round 18 Todo

## Sub-tasks
- [x] 1. Fix sidebar on mobile (DONE — hid PC toggle btn on mobile, neutralized sidebar-collapsed effects in mobile media query so overlay always shows full content)
- [x] 2. Fix sidebar on PC: toggling the button makes members-list background image flash back to normal for a split second (DONE — CSS fix: only fade content children, never .sidebar itself)
- [x] 3. In chatroom: right-click any user → add a "DM user" option to the context dropdown (DONE — added to avatar, sender name, and other-user bubble context menus)
- [x] 4. In user DMs: clicking user's profile picture shows their profile (DONE — added click handler on dm-header-avatar and dm-header-name to openProfileView(activeDMUser), added cursor:pointer styling)
- [x] 5. Syntax-check all script blocks (index.html + server.js) — DONE, all pass
- [ ] 6. Commit + push to GitHub master
- [ ] 7. Verify Render auto-deploy goes live
- [ ] 8. Verify site online (no data wipe) + edits grep-confirmed live
