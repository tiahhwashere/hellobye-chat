# Round 5d — Instant add-friend / cancel button updates on profile view

## Tasks
- [ ] 1. Add refreshProfileViewActions(username) helper that re-renders ONLY the profile-view action buttons from LOCAL state (friendRequests.sent/received, friends, blockedUsers) — no server round-trip
- [ ] 2. Wire it into the Add Friend / Cancel Request / Accept / Decline / Remove Friend button handlers so the buttons swap instantly
- [ ] 3. Also refresh actions after the unfriend-modal confirm and after block/unblock so those swap instantly too
- [ ] 4. Syntax check, commit, push, deploy, verify on Render (no data wiped)
