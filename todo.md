# Request BH — channel persistence, voice layout, webhooks, banner, embeds, invites

## A. Persist active channel across refresh / tab-out / tab-in
- [x] Find channel selection + persistence logic
- [x] Save active channel (server+channel) and restore on load/visibilitychange
- [x] Do not fall back to first/top channel

## B. Voice chat layout — cleaner, non-cartoony, no lag/delay
- [x] Review current voice stage markup/CSS
- [x] Redesign tiles/controls (professional, flat, no cartoonish styling)
- [x] Remove lag/delay sources (bundlePolicy max-bundle, no pulse anims)

## C. Edit Channel — add webhook system with details
- [x] Find Edit Channel modal
- [x] Add webhook UI (create/list/copy/delete + details)
- [x] Backend endpoints for webhooks
- [x] Render webhook messages with their own identity

## D. Server banner image a bit longer (taller)
- [x] Find banner CSS
- [x] Increase height slightly (176px -> 196px, live + preview)

## E. Remove GIF/voice/image/video embed outline; send as own message; keep download button
- [x] Find embed rendering + outline CSS
- [x] Remove outline, render as standalone message, keep download

## F. Invite link paste → show /invite link then server under message
- [x] Find invite link rendering
- [x] Show invite link + server card beneath

## G. Verify + deploy
- [x] node --check server.js + inline JS check
- [ ] Commit + push
- [ ] Trigger Render deploy + verify live
