# Hellobye-Chat — Round 12

## Requests
1. Whenever a user sends a message, show the DATE next to the time it was sent.
2. Whenever a user sends a message, add the iPhone (iMessage) animation.

## Constraints
- Do NOT wipe/delete any existing data.
- Additive-only DB changes.

## Tasks
- [x] A. Add formatMessageDateTime() helper (time · date, year only if not current).
- [x] B. Use it in chat/DM/group message meta; add a meta line to encrypted messages.
- [x] C. Add iPhone-style @keyframes imsgSend + .message-group.imsg-in class.
- [x] D. Apply .imsg-in to newly appended messages (send + receive) in all 4 renderers
         (chat, DM, group, encrypted). Added before DOM insert so only imsgSend plays.
- [x] E. Verify locally:
         - node --check passes for all script blocks.
         - formatMessageDateTime: "02:50 PM · Sep 18" (current yr) / "09:05 AM · Mar 14, 2023" (old).
         - all 4 renderers show date meta + imsg-in class.
         - only imsgSend animation fires (no double msgIn).
         - silent bulk render does NOT animate.
- [x] F. Commit & push.
- [x] G. Verify live.
