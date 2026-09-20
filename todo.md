# Hellobye Chat — Server UI/UX Overhaul (Request T)

## Recon
- [x] Map servers.html structure (server list, channels, members, discovery, join, settings)
- [x] Map server.js endpoints (roles, messages, search, servers, status)
- [x] Identify cartoony styles to remove

## Features
- [x] Server reorder: drag server icons up/down + Move up/down menu (persist order)
- [x] Server owner: delete any message from others (backend + UI)
- [x] Move text channels up/down (drag + context menu, owner)
- [x] Fix Assign Roles (batch endpoint, single request)
- [x] Soft update popup w/ 20s countdown + refresh button (servers.html)
- [x] Server banner: taller image, name pinned top
- [x] Discovery UI: more server details (banner, bio, stats, owner, verified)
- [x] Fix server search messages (decrypt E2E locally)
- [x] Remove lock SVG from Encrypted
- [x] Join a Server: live preview image + more details
- [x] Status (online/offline/idle/dnd) shown in members list (live profile-updated)
- [x] Fix Icon & Banner Scale (header icon + banner transform-origin)
- [x] Remove cartoony style; enhance all server UIs

## Verify & Deploy
- [x] Syntax check server.js + servers.html
- [x] Local smoke test (index 200, servers 200, /api/version ok, no errors)
- [ ] Commit + push to GitHub
- [ ] Render deploy live
- [ ] No data wiped
