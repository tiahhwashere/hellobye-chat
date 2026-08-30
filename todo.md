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


# Round 5g — Revert Round 5f + fix DMs not working for @lore

## Tasks
- [x] 1. Revert Round 5f (Members list right-click Open/Close Conversation change) — commit 4fadbc0
- [x] 2. Fix DMs not working for @lore: ensure owner directMessagesEnabled is always true at startup (added to ensureOwnerClean in server.js)
- [x] 3. Syntax check, commit, push, wait for Render auto-deploy, verify live


# Round 5h — Change 115MB to 150MB limit + redesign toast UI + remove green checkmark icons

## Tasks
- [x] 1. Change all 115MB file size limits to 150MB (index.html: 6 attach button titles/hints + 5 JS size checks; server.js: multer limit + error message + comment)
- [x] 2. Redesign toast UI to be more advanced/polished (CSS + JS)
- [x] 3. Remove green checkmark SVG icons from success/confirm toasts
- [x] 4. Syntax check, commit, push, wait for Render auto-deploy, verify live


# Round 5i — Enter shortcut for media-send-modal + wider non-cartoony media embeds

## Tasks
- [x] 1. Add broader Enter-to-send on media-send-modal (keydown listener on the modal overlay so Enter sends even if the caption textarea isn't focused; keep Shift+Enter for newlines in caption)
- [x] 2. Make media embeds wider (images: 360px→480px, videos: 380px→500px, audio: 320px→400px, file-attachment: 360px→480px) and redesign with non-cartoony, professional look (subtle borders, refined shadows, cleaner radius)
- [x] 3. Update mobile responsive overrides to match the wider embeds
- [x] 4. Syntax check, commit, push, wait for Render auto-deploy, verify live
