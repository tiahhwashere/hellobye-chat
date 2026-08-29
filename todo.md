# Round 26 Todo

## 1. Fix flash of broken UI on signin/signup/refresh
- [x] Investigate what causes the broken UI flash (chat-app visible before initChat finishes loading data)
- [x] Fix CSS/JS so only the correct UI shows (loading overlay covers chat grid until data ready)
- [ ] Verify on live site

## 2. Add file upload dropdown to group chat (matching DMs + chatroom)
- [x] Find the existing upload dropdown UI in DMs/chatroom
- [x] Replicate the same dropdown for group chat input (group-attach-dropdown with GIF + Image/Video)
- [x] Wire up the group chat upload to use the dropdown (toggle, close-on-outside-click, reposition on scroll/resize)
- [ ] Verify on live site

## 3. Add "Allow being added to group chats" toggle in Notifications & Appearance
- [x] Find the Notifications & Appearance settings section
- [x] Add a toggle option for group chat invites (group-add-toggle)
- [x] Add backend support (user setting allowGroupAdd + enforcement in group-create and group-add endpoints)
- [ ] Verify on live site

## 4. Deploy & verify all
- [ ] Commit, push, verify Render deploy
- [ ] Test all 3 features on live site
