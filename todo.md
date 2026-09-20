# Request X — Servers polish round 5

## 1. Invite revoke permissions
- [x] Frontend: only the server OWNER sees the revoke button on active invites
- [x] Backend: DELETE /api/servers/:id/invites/:code requires owner (non-owners blocked)

## 2. @everyone / @here colors -> blueish
- [x] .mention-everyone + .mention-here -> dark/light blueish
- [x] .mention-ping message highlight -> blueish
- [x] linkify + toast accents updated

## 3. Red notification -> darkish golden
- [x] .ch-ping-dot -> darkish golden
- [x] .mention-toast border/accent -> darkish golden
- [x] showPingToast accent -> darkish golden

## 4. Advanced placeholders (no emojis)
- [x] Rewrite all input/textarea placeholders to be richer & professional
- [x] Upgrade empty states (channel start, no roles, no results, assign empty)

## 5. Assign Roles checkmark first-click fix
- [x] Fix double-toggle so the check registers on the first click

## 6. Verify & Deploy
- [x] node --check on server.js + extracted servers.html script
- [x] Smoke test locally (invite revoke 403/200 verified)
- [x] Commit + push to GitHub master
- [x] Trigger/verify Render deploy (no data wiped)
