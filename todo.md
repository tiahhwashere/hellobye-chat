# Round 5d — Instant add-friend / cancel button updates on profile view

## Tasks
- [x] 1. Add refreshProfileViewActions(username) helper that re-renders ONLY the profile-view action buttons from LOCAL state (friendRequests.sent/received, friends, blockedUsers) — no server round-trip
- [x] 2. Wire it into the Add Friend / Cancel Request / Accept / Decline button handlers so the buttons swap instantly
- [x] 3. Also refresh actions after the unfriend-modal confirm and after unblock so those swap instantly too
- [x] 4. Syntax check, commit, push, deploy, verify on Render (no data wiped)


# Round 5e — Instant Block→Unblock swap + hide blocked users’ messages

## Tasks
- [x] 1a. Add refreshProfileViewActions(username) inside blockUser after the optimistic blockedUsers.push block so the profile button swaps to Unblock instantly
- [x] 1b. Change the block-confirm modal handler from closeProfileView() to refreshProfileViewActions(username) so the profile view stays open and the button swaps instantly
- [x] 2. Add blocked-user filtering to renderMessages (msg.username), renderDMMessages (m.from), and renderGroupMessages (m.from); add isUserBlocked(username) helper
- [x] 3. Syntax check, commit, push, wait for Render auto-deploy, verify live, confirm no data wiped
