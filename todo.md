# Hellobye Chat Update Tasks — Round 31

## 1. Friend request logic
- [x] When friend requests are OFF: only show "has friend requests turned off" (do NOT show "Friend request has been sent to")
- [x] When friend requests are ON: show "Friend request has been sent to"

## 2. Member list background persistence
- [x] If user has a member list background set, on logout revert it to normal
- [x] When user logs back in, add it back

## 3. Account UI icons
- [x] Remove the icon from "Disable your account?" UI
- [x] Remove the trashcan icon from "Delete your account?" UI

## 4. Member stats fix
- [x] Fix the 3 members stat: online · dnd · offline (idle merged into online)

## 5. Notification UIs revamp
- [x] Revamp notification UIs when toggling options (modern + professional, refined toast CSS + contextual messages)

## 6. Profile/Banner update UIs
- [x] Revamp "Profile picture has been updated." UI (premium confirm toast)
- [x] Revamp "Banner has been updated." UI (premium confirm toast)

## 7. Group chat GIF support
- [x] Allow GIF support for group chat profile (owners) (accept + hint)
- [x] Ensure animated GIF works and is visible for all users/members (skipAnimated + clean render)

## 8. Search Messages UI animation
- [x] Add revamped open/close animation for the Search Messages UI (slide+scale+staggered fade)

## 9. Conversation closed UI
- [x] Revamp "Conversation closed. Reopen it anytime by right-clicking the Messages tab." UI (info toast + optimistic)
- [x] Ensure close/open conversation right-click dropdown options work (not broken)

## 10. Deploy
- [x] Commit and push to GitHub (commit 2924e25 pushed to master)
- [x] Deploy/update on Render (autoDeploy triggered, deploy dep-da9f9b3n live)
- [x] Verify at https://hellobye-chat.onrender.com/ (HTTP 200, Round 31 code confirmed)
