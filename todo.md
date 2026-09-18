# Hellobye-Chat — Round 10: Delete-Key UI + Profile Preview + Wider Profile + Remove E2E SVGs

## Context
User requests:
1. Add a proper UI to the "Delete Key" button and make it send a REQUEST to the
   other user (Accept / Decline) that actually works.
2. Make the profile-view modal (when viewing another user) a bit WIDER
   (not a square box).
3. In Profile Settings, beside "Remove Picture", add a "Preview" button that
   shows the profile POV others see when clicking your profile.
4. "add a 30" — AMBIGUOUS; awaiting clarification (not implemented yet).
5. Remove ALL SVG icons from the E2E encrypted UIs (enc modals + enc chatroom).

## Constraints
- Do NOT wipe/delete any existing data (users, messages, groups, etc.).
- Additive-only DB changes.
- Encrypted chat messages/files stay ciphertext-only.

## Tasks
- [x] A. Server: `delete-request` + `delete-respond` endpoints (accept -> wipe key
         + history; decline -> nothing changes). Add deleteBy/deletePending to
         publicEncChat.
- [x] B. Frontend: Delete-Key request modal (Accept/Decline/Close) + socket
         listeners + wire the delete-key button to the request flow.
- [x] C. Frontend: widen `.profile-view-modal` (760px -> 900px).
- [x] D. Frontend: "Preview" button beside "Remove Picture" in Profile Settings
         (renders the profile-view modal as others see it, from live inputs).
         Fixed z-index so preview sits above the settings panel (z 400).
- [x] E. Frontend: remove ALL SVG icons from the E2E encrypted UIs
         (enc modals, enc chatroom overlay, enc-chat entry button).
- [x] F. Verify locally (delete flow + preview + wider modal + no enc SVGs).
         - delete flow: test_delete.js all pass (request/decline/accept).
         - preview: renders on top, 900px, "This is how other members see..." notice.
         - wider modal: 900px confirmed for other-user profile view.
         - no enc SVGs: 0 in enc block, 0 in enc overlay, 0 in enc modals.
- [ ] G. Commit & push to GitHub.
- [ ] H. Verify live deploy + no data loss.
