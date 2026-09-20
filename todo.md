# Request AC — Disable custom invite link for non-server-owners

## 1. Frontend gating
- [x] `applySettingsPermissions`: custom invite input disabled + dimmed for non-owners; hint text updated
- [x] `gen-invite-btn` handler: non-owners never send a custom code (random only)

## 2. Backend enforcement
- [x] `/api/servers/:id/invites`: reject custom codes from non-owners with 403

## 3. Verify & Deploy
- [x] node --check server.js + extracted servers.html script
- [x] E2E API test: member custom -> 403, member random -> 200, owner custom -> 200
- [x] Cleanup test file + restore data/db.json seed
- [x] Commit + push to GitHub master (4092990)
- [x] Trigger/verify Render deploy (live, no data wiped)
