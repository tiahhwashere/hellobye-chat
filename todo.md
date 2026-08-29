# Hellobye Chat — Feature Update Round 28

## Backend (server.js)
- [x] 1. Add account-disable system: new fields (disabled, disabledAt, scheduledDeletionAt, originalProfile snapshot) + `/api/settings/disable-account` endpoint (logs user out, resets profile to "deleted user" + default pic)
- [x] 2. Login flow: detect disabled accounts -> return `accountDisabled` flag so frontend shows reactivation UI; add `/api/account/reactivate` endpoint
- [x] 3. Add 30-day auto-purge: prune disabled accounts past deadline on load + periodic check
- [x] 4. `/api/user/:username` -> return 404 "User not found" for disabled accounts (profile hidden)
- [x] 5. `publicUser`/`fullUser`/`emitUsersList`/`broadcastProfile` -> exclude/skip disabled users
- [x] 6. Group chat name: enforce 10 char limit in create + settings endpoints (slice 10)
- [x] 7. Remove music-player backend: delete `/api/settings/music-link` + `/api/validate-music-link` endpoints (keep data intact, just stop serving)
- [x] 8. Group create: enforce max 10 members (already done) — verify

## Frontend (index.html)
- [x] 9. Remove Music Player system fully (HTML section, CSS, JS MusicPlayer object, wiring, restore code, script tags)
- [x] 10. Group settings: unsaved-changes detection on icon upload + name change; show "You have unsaved changes" UI with Save/Discard; Discard reverts icon+name to saved state
- [x] 11. Group name input: set maxlength=10 + enforce 10 char limit client-side
- [x] 12. Group chat member cap: enforce max 10 (UI guard on add) — verify count display shows /10
- [x] 13. Profile picture zoom: clicking user's profile picture in profile-view modal zooms the image
- [x] 14. Danger Zone: add "Disable Account" option card + modal (password confirm) -> calls disable endpoint -> logs out
- [x] 15. Login reactivation UI: when server returns accountDisabled, show reactivation prompt modal ("Reinstate your account?") with Reactivate / Leave disabled buttons
- [x] 16. Disabled-user profile click -> notification "User not found"

## Deploy
- [ ] 17. Commit + push to GitHub
- [ ] 18. Trigger Render deploy & verify live site
