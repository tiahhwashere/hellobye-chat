# Hellobye-Chat — Round 2 Bug Fixes & Improvements

## Bugs to Fix
- [x] A. "No video with supported format and MIME type found" — fix video playback (add explicit MIME type to video elements + ensure server returns correct Content-Type)
- [x] B. Reaction emoji still gets stuck sometimes after user removes it — strengthen the in-flight guard / fix server-side race
- [x] C. .txt file sent in chat: show file contents inline with a download button + copy button

## Deploy
- [x] Commit & push to GitHub
- [x] Deploy to Render (autoDeploy)
- [x] Verify live at https://hellobye-chat.onrender.com/
- [x] Ensure no data deleted/removed
