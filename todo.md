# Hellobye-Chat — Round 11

## Requests
1. Remove the "This is how other members see your profile." notice from the preview.
2. Improve the Preview button styling ("a little more better").
3. Make the Encrypted chatroom wider (not a square box).
4. Fix the Delete Encryption Key Accept/Decline not working.
5. Persist the encrypted chatroom across page refresh (don't exit on reload).

## Constraints
- Do NOT wipe/delete any existing data.
- Additive-only DB changes.

## Tasks
- [x] A. Remove preview notice (.pv-preview-notice) from renderProfileView.
- [x] B. Improve Preview button styling (gradient + shadow + hover lift).
- [x] C. Widen the encrypted chatroom (.enc-panel 760px -> 1080px, max-h 860px).
- [x] D. Fix Delete Encryption Key accept/decline: buttons were never wired.
         Added on('enc-delete-accept'/'decline'/'close') handlers.
- [x] E. Persist enc chatroom across refresh (sessionStorage key + restoreEncRoomSession
         called in initChat; cleared on close/logout).
- [x] F. Verify locally:
         - preview notice gone (actions row hidden, no .pv-preview-notice).
         - preview button gradient/shadow confirmed.
         - enc panel 1080px confirmed.
         - delete accept/decline clicks fire respondEncDelete('accept'/'decline').
         - refresh re-opens the enc room (encShow true, encActiveUser restored).
- [x] G. Commit & push (135432f on master).
- [x] H. Verify live:
         - live site HTTP 200.
         - restoreEncRoomSession present; enc-panel max-width 1080px.
         - pv-preview-notice removed (0 occurrences).
         - enc-delete-accept handlers present.
         - delete-request/delete-respond endpoints return 401 (exist, auth-gated).
         - GitHub backup DB (hellobye-chat-data/data/db.json) intact (17484 bytes).
