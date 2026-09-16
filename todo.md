# Hellobye-Chat — Round 7: Mutual Encryption Chatroom (E2E, key-gated)

## Context
User request: In DMs, ONLY when the two users are friends, add an "Encryption Chat"
button right beside the Search Messages button. Clicking it sends BOTH users an
encryption-chatroom invite popup (Join / Exit). Both Exit → UI exits. Both Join →
each user gets a one-time 24-letter encryption key (copyable, shown once). Entering
the correct key opens an end-to-end encrypted chatroom (same DM system/UI) that
NOBODY but the two users can read — not even the owner. The chatroom has a
"Back to Normal DMs" button; both accept → switch back to normal DM, both deny →
exit the UI.

## Constraints
- Do NOT wipe/delete any existing data (users, messages, DMs, friends, groups).
- Additive-only DB changes (new `encryptionChats` field).
- Encryption chat messages stored as ciphertext only; never exposed to admin/owner.

## Tasks
- [x] A. Update todo.md for Round 7
- [x] B. Server: add `db.encryptionChats` store + pair-key helpers (additive, no data loss)
- [x] C. Server: REST endpoints (invite / respond / verify / return-request / return-respond / status)
- [x] D. Server: socket handler `encryption-send` (store ciphertext, relay to peer)
- [x] E. Frontend: CSS for encryption button, invite/key/return modals, encrypted chatroom overlay
- [x] F. Frontend: HTML for the button, modals, and encrypted chatroom overlay
- [x] G. Frontend: client JS (invite flow, one-time key, key entry, E2E encrypt/decrypt, return flow)
- [x] H. Frontend: socket listeners for real-time encryption events
- [x] I. Frontend: show button only when friends (updateDMHeader)
- [x] J. Verify locally (server boots, endpoints respond, no data loss)
- [x] K. Commit & push to GitHub
- [x] L. Trigger Render deploy & verify live site (deploy dep-daldel15efls73bb3du0 = live)
- [x] M. Confirm no data deleted/removed (live restored 5 users/4 msgs/5 DMs/5 friends/1 group from backup)

## Round 7b — Fix: server error in encryption chat (post-deploy)
- [x] N. Root cause: remote DB restore replaced `db` with a backup lacking `encryptionChats` → `db.encryptionChats[id]` threw "Cannot read properties of undefined (reading 'hi::lore')"
- [x] O. Fix: defensive guard in `getEncChat` + re-ensure `encryptionChats`/`groupChats` in remote-restore block
- [x] P. Fix: generic error handler no longer mislabels all errors as "Server error during upload."
- [x] Q. Verify: full encryption flow passes with a db lacking `encryptionChats` (status/invite/join/verify/return all 200)
- [ ] R. Commit & push fix
- [ ] S. Verify live deploy + no data loss
