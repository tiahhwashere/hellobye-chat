# Request BN — loop loading, voice icon, toast icons, invite banner, # channels, message actions, timezone, effects

## 1. Fix loop loading on channel switch / refresh
- [x] Reproduce the infinite loading loop
- [x] Fix root cause (loadServer left a stuck spinner when the active channel was still valid; now re-opens it. openChannel also shows an error state instead of spinning forever on a failed fetch)

## 2. Better "In voice" icon (replace camera svg)
- [x] Swap to a proper voice/mic icon

## 3. Remove ALL svg/icons from every toast UI
- [x] index.html toasts
- [x] servers.html toasts (incl. ping/reply toasts)

## 4. Invite/custom link banner taller
- [x] Increase embed height (116px desktop / 88px mobile)

## 5. Fix # channel mentions
- [x] Ensure channel autocomplete + rendering works (added # autocomplete popover + insertChannelMention; highlighting/click already worked)

## 6. Message actions under the message (not far away)
- [x] delete, edit, pin, react, create thread, reply (moved into .msg-body, in-flow under the message)

## 7. Message time synced to user timezone
- [x] Fix timestamp rendering (robust parseTs treats timezone-less strings as UTC; full local-time hover tooltip)

## 8. Fix Effects not working/showing
- [x] Diagnose + fix (server.js effect allowlist was missing beam/ripple/frost/ember)

## 9. Verify + deploy
- [x] syntax checks, visual verify, commit, push, verify live
