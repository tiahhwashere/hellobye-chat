# Hellobye-Chat — Round 9: Key Reset Request + gg sans font

## Context
User requests:
1. In the "Enter Encryption Key" modal, add a "Reset Key" button beside "Unlock".
2. Clicking it sends a key reset request to the other user.
3. The other user must Accept or Decline.
4. If declined → tell the requesting user the other user declined.
5. If accepted → reset the E2E key, invalidate the old key, delete all old
   encrypted chats from the old key.
6. Make all website text fonts "gg sans".

## Constraints
- Do NOT wipe/delete any existing data (users, messages, groups, etc.).
- Additive-only DB changes.
- Encrypted chat messages/files stay ciphertext-only.

## Tasks
- [x] A. Server: `reset-request` endpoint (state 'resetting', notify both)
- [x] B. Server: `reset-respond` endpoint (accept → new key + wipe old ciphertext; decline → keep key)
- [x] C. Frontend: "Reset Key" button in enc-enter-modal beside Unlock
- [x] D. Frontend: reset request modal (Accept/Decline) + socket listeners
- [x] E. Frontend: declined → notify requester; accepted → new key modal
- [x] F. Fonts: apply "gg sans" across the whole site (self-hosted woff2)
- [x] G. Verify locally (full reset flow + font)
      - REST: request → resetting; self-respond blocked; decline keeps old key;
        accept issues new key, old key 403, new key 200.
      - Socket: encrypted msg stored (1) → after accept wiped (0).
      - UI: Reset Key button beside Unlock; reset modal Accept/Decline;
        requester waiting state (Close only). gg sans loaded + applied.
- [ ] H. Commit & push to GitHub
- [ ] I. Verify live deploy + no data loss
