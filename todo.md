# Servers System — Build Plan

## 1. Backend (server.js)
- [x] Add `db.servers` + `db.serverInvites` to defaultDB and ensure-on-load (non-destructive)
- [x] Add server helpers (publicServer, findServer, permissions, invite codes)
- [x] Add REST endpoints: create/list/get/settings/icon/banner, channels CRUD, roles CRUD, member roles/kick/nickname, leave/delete, invites create/list/revoke, invite preview + join, member profile
- [x] Add socket events: server-send/edit/delete/typing/react (E2E ciphertext only)
- [x] Add invite-preview endpoint for link embeds
- [x] Add short `/CODE` invite redirect route

## 2. New page (servers.html)
- [x] Full server system UI: server rail, channel list, chat area, member list
- [x] Create/join server flows
- [x] Owner commands: add/delete channels, roles, badges, permissions
- [x] Server profile: icon/banner/bio editing
- [x] Member count display
- [x] Invite generation with 30min→never expiry + copy link
- [x] E2E encrypted chatroom (AES-GCM, per-server key wrapped per member)
- [x] "Back to main chat" button

## 3. Main page (index.html)
- [x] Add "Servers" nav button after Blocked (opens /servers.html)
- [x] Invite-link embeds (server name/icon/member count) in public chat, DMs, group chats, encrypted rooms

## 4. Deploy
- [x] Syntax check server.js + servers.html + index.html
- [x] Update Dockerfile to include servers.html
- [x] Local end-to-end smoke test (REST + socket)
- [ ] Commit & push to GitHub master
- [ ] Verify Render deploy live
- [ ] Confirm no data wiped
