# Fix: "Hide profile from others" should work for everyone (not just @lore)

## Diagnosis
- [x] Clone repo & locate hideProfile logic
- [x] Identify bug: server.js /api/user/:username `viewerIsOwner = isOwnerUser(me)` bypassed hiding only for @lore
- [x] Identify leaks: /api/users member list + profile-updated socket broadcast sent full bio/statusMessage/pronouns to ALL viewers
- [x] Identify client-side mirror bug: index.html live-update `viewerIsOwner` bypass

## Fix
- [x] Add applyProfileHiding() helper — strips sensitive fields for hidden profiles for every viewer EXCEPT self (no owner bypass)
- [x] publicUser() now viewer-aware; fullUser()/api/me passes self username so self keeps full data
- [x] /api/users viewer-aware — redacts hidden profiles in member list
- [x] /api/user/:username — removed owner bypass; hiding = hidden from all other viewers incl @lore
- [x] broadcastProfile() — full to self room, redacted to everyone else via io.except (no leak, self state preserved)
- [x] Client live-update handler — removed viewerIsOwner bypass

## Verify
- [x] node --check server.js OK
- [x] Boot test (HTTP 200)
- [x] 15-case automated API test: viewer redacted, @lore also redacted (no bypass), self full, member list redacted, /api/me full, non-hidden unaffected — ALL PASSED

## Deploy
- [x] Commit & push to GitHub master (1e759e1)
- [x] Render auto-deploy triggered (new_commit) -> status: live
- [x] Live site https://hellobye-chat.onrender.com/ serves updated code (200, fix string present, old bypass gone)
- [x] No data wiped (data/db.json untouched; production data in external GitHub backup repo unchanged)
