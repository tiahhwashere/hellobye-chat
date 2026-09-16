# Hellobye-Chat — Round 8: Encrypted chatroom upgrades

## Context
User requests for the mutual encryption chatroom:
1. Add the same media sender (files/images/videos/GIFs) to the encrypted chatroom.
2. Make the 24-letter key random & different every time users enter the chatroom,
   but only if the user hasn't deleted their key yet.
3. Add an option to delete messages in the encrypted chatroom.
4. Remove the X (close) button from the encrypted chatroom.
5. Fix "A network error occurred. Please try again."

## Constraints
- Do NOT wipe/delete any existing data. Additive-only DB changes.
- Encrypted chat messages/files stay ciphertext-only; never exposed to admin/owner.

## Findings (Task A)
- Full encryption REST + socket flow reproduced locally with NO deterministic error.
- Root cause of "network error": (a) invalid CORS combo — frontend sends
  credentials:'include' while server returns Access-Control-Allow-Origin:'*',
  which browsers reject cross-origin; (b) Render free-tier cold starts cause
  transient fetch failures with no retry. Fix = reflect Origin + retry wrapper.

## Tasks
- [x] A. Reproduce the "network error" locally to find the real cause
- [x] B. Server: `encryption-delete` socket handler (delete own enc messages, relay)
- [x] C. Server: key rotation per session + `keyDeleted` + delete-key endpoint
- [x] D. Frontend: media sender in enc chatroom (client-side encrypt file bytes, upload ciphertext, render decrypted)
- [x] E. Frontend: delete-message option on enc messages
- [x] F. Frontend: remove the X close button from the enc chatroom
- [x] G. Frontend: "Delete Key" option
- [x] H. Frontend: fix the network error (retry wrapper + CORS reflect)
- [x] I. Verify locally (full flow + media + delete + key rotation)
      - Full REST flow OK; key rotation OK (rotates each entry, keeps key when deleted);
      - socket send/media/delete OK; UI: no X button, Delete Key, media sender, delete msg OK;
      - fixed 2 bugs found in testing: duplicate own message (ack+echo race) & empty-state not removed;
      - CORS reflects Origin with credentials OK.
- [x] J. Commit & push
- [x] K. Verify live deploy + no data loss
      - Deploy dep-daleh23ncjis73e56hag status=live (commit d6c0412).
      - Live index.html contains new code (enc-delete-key-btn, enc-attach-btn,
        enc-file-input, encryption-delete, encryption-key-existing, encFetch,
        encResolveFile) and NO enc-close-btn.
      - Live routes: GET /api/encryption/status → 401 JSON; POST
        /api/encryption/delete-key → 401 JSON (routes present).
      - GitHub backup DB intact: 5 real users (lore, swirlpup, hi, pwonttalk,
        zombie), 4 messages, 1 group chat, 1 encryption chat (hi::lore),
        customRoles=1, welcomeTitle preserved. NO test data leaked.
