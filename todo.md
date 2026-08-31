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


# Round 5j — Remove GIF picker option, add optional spoiler for file messages, rename "Send in Chat", revamp UI

## Tasks
- [x] 1. Investigate current attach/send UI: find "Send a GIF / Video" vs "Send Image/Video" UI elements, "Send in Chat" text, file attach dropdown/buttons
- [x] 2. Remove the "Send a GIF / Video" option UI (keep the image/video file upload) — attach buttons now directly trigger file input
- [x] 3. Add optional spoiler feature: when sending files, user can mark as spoiler; message content hidden until clicked (client → socket → server → render chain)
- [x] 4. Rename "Send in Chat" → "Share in Chat" / "Share in Direct Message" / "Share in Group"; confirm button "Send"→"Share"; modal title "Send Media"→"Share Attachment"
- [x] 5. Revamp and modernize the media-send-modal UI — header with icon, custom spoiler toggle switch, improved preview area, refined spacing
- [x] 6. Syntax check (both pass), commit, push, wait for Render auto-deploy, verify live

# Round 5k — Restore file attach dropdown (remove only GIF URL option)

## Tasks
- [x] 1. Restore attach dropdown toggle behavior for all three contexts (chat, DM, group)
- [x] 2. Restore click-outside-to-close handler for dropdowns
- [x] 3. Restore resize/scroll reposition handlers for dropdowns
- [x] 4. Keep dropdown HTML with single "Upload File" item (GIF URL option stays removed)
- [x] 5. Syntax check, commit, push, wait for Render auto-deploy, verify live


# Round 6 — Share-in-Chat UI, upload loading, 5-file limit, duplicate-file bug, profile buttons blend

## Tasks
- [x] 1. Redesign "Share in Chat" media-send modal: cleaner, more basic yet professional UI + rename "Share in Chat" → "Send Attachment" (and DM/group variants)
- [x] 2. Fix uploading-on-send loading UI: show a clear spinner/loading state on the send button + preview bar while files upload
- [x] 3. Enforce max 5 files at one time (both main chat + DM): hard cap, block adding beyond 5 (not just slice)
- [x] 4. Fix duplicate-file bug: when a user uploads multiple files, the first file no longer renders twice (file + files overlap)
- [x] 5. Profile view: Send Message / Add Friend / Block buttons auto-blend with the user's panel/profile color (auto-blind in)
- [x] 6. Syntax check, commit, push to GitHub, deploy to Render, verify live (no data wiped)

# Round 7 — "This Profile is Private" UI redesign

## Tasks
- [x] 1. Redesign `.pv-hidden-notice` CSS: wider (full-width, wider left-right padding), better-made looking (card with subtle border, gradient/surface bg, refined spacing, badge-style title)
- [x] 2. Remove the lock SVG icon from the JS HTML template (and from the panel-color selector list)
- [x] 3. Improve `.pv-hidden-title` and `.pv-hidden-sub` styling for a more polished, professional look
- [x] 4. Clean up the `applyProfileViewPanelColor` icon reference (remove `.pv-hidden-icon` selector since icon is gone)
- [x] 5. Syntax check, commit, push to GitHub, deploy to Render, verify live (no data wiped)

# Round 8 — One-time welcome popup for new accounts + simplify private-profile subtitle

## Tasks
- [ ] 1. Add welcome modal HTML (one-time popup shown only on new account creation)
- [ ] 2. Add CSS for welcome modal (clean, professional, branded)
- [ ] 3. Add showWelcomeModal() JS function + trigger it only after signup (not login/refresh)
- [ ] 4. Simplify the "This Profile is Private" subtitle to be basic but semi-professional
- [ ] 5. Syntax check, commit, push to GitHub, deploy to Render, verify live (no data wiped)
