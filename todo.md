# Hellobye-Chat — Round 2 Bug Fixes & Improvements

## Bugs to Fix
- [x] A. "No video with supported format and MIME type found" — fix video playback (add explicit MIME type to video elements + ensure server returns correct Content-Type)
- [x] B. Reaction emoji still gets stuck sometimes after user removes it — strengthen the in-flight guard / fix server-side race
- [x] C. .txt file sent in chat: show file contents inline with a download button + copy button

## Deploy
- [ ] Commit & push to GitHub
- [ ] Deploy to Render (autoDeploy)
- [ ] Verify live at https://hellobye-chat.onrender.com/
- [ ] Ensure no data deleted/removed
