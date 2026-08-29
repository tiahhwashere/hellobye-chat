# Round 25 Todo — Fix "Unable to load this profile" + ALL broken settings/UIs/features/backgrounds

## Root Cause Analysis
- [x] Investigate "Unable to load this profile" error on live site
- [x] Discover JS crash: `TypeError: Cannot read properties of null (reading 'on')` at line 10854
- [x] Identify root cause: 6 group socket listeners at TOP LEVEL of script, but `socket` is null until `connectSocket()` runs after login
- [x] Confirm this crash broke ALL features (profiles, settings, backgrounds, UIs) by stopping JS execution at parse-time

## Fixes Applied
- [x] Move 6 group socket listeners (group-message, group-updated, group-removed, group-edited, group-deleted, group-typing) from top-level INTO `connectSocket()` function
- [x] Verify JS syntax passes (node --check)
- [x] Verify server.js syntax + boot test
- [x] Fix duplicate group messages: add dedup check (by message ID) in group-message listener
- [x] Fix duplicate group messages: add dedup check in doSendGroup ack callback
- [x] Fix duplicate group messages: add dedup check in sendGroupWithFile ack callback

## Deploy & Verify
- [x] Commit and push all fixes (commits 741e961, f8a94bf, b77a73b)
- [x] Verify Render deploys go live
- [x] Test live site: no JS errors, all functions defined (connectSocket, openProfileView, renderMessages, init, sendGroupMessage)
- [x] Test login/registration: works, full chat UI renders with user list
- [x] Test profile view: "Unable to load this profile" error GONE — profile modal shows avatar, name, badges, ID, bio, pronouns, member since
- [x] Test settings panel: works — banner, profile pic, status, about me, privacy, pronouns, panel theme color
- [x] Test background feature: works — upload/URL/clear, image scale, color overlay, apply
- [x] Test group chat: creation works, member search/add works, messaging works, no duplicate messages
- [x] Test DMs/Messages view: works — empty state, group chat listed

## Summary
Root cause was a single bug: group chat socket listeners at the top level of the script
crashed because `socket` was null. This cascading crash broke every feature. Moving the
listeners inside connectSocket() fixed everything. Also fixed a duplicate message issue
in group chat as a bonus.
