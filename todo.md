# Round 5d — Instant add-friend / cancel button updates on profile view

## Tasks
- [x] 1. Add refreshProfileViewActions(username) helper that re-renders ONLY the profile-view action buttons from LOCAL state (friendRequests.sent/received, friends, blockedUsers) — no server round-trip
- [x] 2. Wire it into the Add Friend / Cancel Request / Accept / Decline button handlers so the buttons swap instantly
- [x] 3. Also refresh actions after the unfriend-modal confirm and after unblock so those swap instantly too
- [x] 4. Syntax check, commit, push, deploy, verify on Render (no data wiped)
