# Hellobye-Chat — Bug Fixes & UI Improvements

## Bugs to Fix
- [x] 1. Emoji reaction remove bug: reacting with emoji then removing it gets stuck (add in-flight guard)
- [x] 2. Mini profile: whiteish part shows when changing Panel Theme Color (cover .cw-value-slider + .mini-statusmsg-hint)
- [x] 3. File/image/video/gif embed layout — make it look even better
- [x] 4. Message spacing/sizing: long messages or copy-paste shouldn't take over the whole chatroom/DM/groupchat (constrain .message-bubble max-width + min-width:0)
- [x] 5. Regenerate Recovery Code UI: make Cancel button same size as Confirm button (prompt2SVPassword)
- [x] 6. Revoke Trusted Devices UI: same fix (prompt2SVPassword)
- [x] 7. View Recovery Code UI: same fix (prompt2SVPassword)
- [x] 8. Better icons for "change picture" and "remove picture" in Profile Settings
- [x] 9. "Adjust profile picture" preview: bigger/wider, more space, show full profile picture without seeming cropped (object-fit: contain + bigger frame)

## Deploy
- [ ] Commit & push to GitHub
- [ ] Deploy to Render
- [ ] Verify live at https://hellobye-chat.onrender.com/
- [ ] Ensure no data deleted/removed
