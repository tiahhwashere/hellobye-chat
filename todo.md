# Hellobye Chat — Remove bottom notification, keep red badge

## Investigation (DONE)
- [x] Cloned repo & confirmed live deploy = latest commit (Round 9, aabb502)
- [x] Mapped notification system:
  - Bottom notification = showInAppNotification() rich cards in #toast-container (bottom-center) + toast() toasts
  - Red notification = #dm-nav-badge unread count on Messages tab + per-conv .dm-unread-badge
- [x] Confirmed DM-receive -> updateDMNavBadge works for friends & non-friends (only blocked / DM-disabled excluded)
- [x] Confirmed socket room join user:${username} is correct on server

## Implementation (DONE)
- [x] Verified DM-receive shows NO showInAppNotification/toast (only sound + red badge) — already correct
- [x] Removed DM-ping bottom toast ("mentioned you in a DM") -> badge-only
- [x] Red badge (#dm-nav-badge) is the sole DM signal; works for any user (friend/non-friend) via dm-receive -> updateDMNavBadge
- [x] Kept public-chat behavior intact
- [x] JS syntax check passed (3 script blocks, 0 errors)

## Deploy
- [ ] Commit + push to GitHub master
- [ ] Confirm Render auto-deploy picks up commit (autoDeploy=commit)
- [ ] Trigger/verify deploy goes live; site back online
- [ ] Verify no data wipe (db.json untouched)
