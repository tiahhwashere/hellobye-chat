# Round 23 — Todo

## Task 1: Image zoom — zoom the whole square box, not just the inner image
- [x] Modify `openImageLightbox` / `#image-lightbox` CSS & JS so clicking to zoom scales the whole stage container (the square box), not just the inner `<img>`. Also make the image bigger by default.

## Task 2: Administrator Panel — make ALL the UIs look way better
- [x] Comprehensive visual overhaul of all admin subtabs (activity, accounts, ban, mute, roles, messages, broadcast, whitelist, customroles): cards, headers, inputs, lists, spacing, polish.

## Task 3: Group chat system (major feature)
### Server (server.js)
- [x] Add `db.groupChats` array to defaultDB + migration guard
- [x] POST `/api/groups/create` — create group (owner, name, members, icon)
- [x] GET `/api/groups` — list groups the user is a member of
- [x] GET `/api/groups/:id` — get one group's messages + metadata
- [x] Socket `group-send` — send group message; emit `group-message` to members
- [x] POST `/api/groups/:id/settings` — owner: change name
- [x] POST `/api/groups/:id/icon` — owner: upload icon
- [x] POST `/api/groups/:id/kick` — owner: kick a member
- [x] POST `/api/groups/:id/add` — owner: add a member
- [x] POST `/api/groups/:id/leave` — member leaves group
- [x] Socket.io events: `group-message`, `group-updated`, `group-member-changed` (group-edited, group-deleted, group-typing, group-removed)
- [x] Purge expired deleted group messages in cleanup
- [x] Username migration for group chats

### Frontend (index.html)
- [x] Add plus (+) button under search members in messages tab (HTML+CSS)
- [x] Group chat creation modal (search/add members, name, create) (HTML)
- [x] Group chat view (reuse DM overlay pattern) showing all members + messages (HTML)
- [x] Group chat settings panel: owner can change icon, name, kick, add members (HTML)
- [x] JS: plus button → open create modal
- [x] JS: create modal logic (search, select, create group)
- [x] JS: load groups + render in DM list alongside DMs
- [x] JS: openGroup, renderGroupMessages, appendGroupMessage
- [x] JS: send group message (socket group-send) + file attach
- [x] JS: group socket event listeners (group-message, group-updated, etc.)
- [x] JS: group settings modal (icon, name, kick, add, leave)
- [x] JS: group reply, edit, delete context menus

## Task 4: Deploy
- [ ] Syntax check both files
- [ ] Commit & push to GitHub
- [ ] Verify Render deploy
