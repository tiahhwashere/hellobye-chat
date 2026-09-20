# Request R — Servers UI/UX fixes & features

## 1. Owner crown emoji
- [x] Remove the crown emoji from the owner display in servers

## 2. Owner role add/remove
- [x] Allow the owner role to be added/removed from the owner (roles tab)

## 3. Members profile UI
- [x] Make the Members profile UI/style match the main chat profile UI

## 4. GIF support for banner/profile
- [x] Add GIF support for server banner/profile picture (~25 MB max)

## 5. Upload file dropdown + loading bar + 150MB
- [x] Upload button opens a dropdown first (image/video/file)
- [x] Show files with a loading/progress bar
- [x] Actually send file/gif/video with 150 MB limit

## 6. Profile Completeness skip persistence
- [x] Skip keeps it at 100% across refresh/tab-off until "undo skip"

## 7. GIF flicker
- [x] Fix the GIF flicker

## 8. Server invite embed flicker
- [x] Fix the server link invite embed flicker

## 9. Empty-state copy
- [x] Rewrite the "Create your own community..." message (simple + professional)

## 10. Verify & deploy
- [x] Syntax check server.js + servers.html script
- [x] Fix upload progress-bar crash (missing #server-input-area id) + response shape ({file:{url}})
- [x] Restore data/db.json to clean baseline (no test pollution)
- [x] Commit + push to GitHub (master)
- [x] Verify Render deploy + live site
- [x] Confirm no data wiped
