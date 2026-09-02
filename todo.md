# Hellobye-Chat — Round 3 Bug Fixes & Improvements

## Tasks
- [x] A. Remove "updates underway" from the mini profile
- [x] B. Change 150MB file upload limit to 250MB
- [x] C. Fix any other bugs found around the website
  - Fixed: dismissNotifsForUser used CSS.escape (for CSS identifiers) instead of cssAttrEscape (for attribute selector string values) — now uses the correct escape function
  - Cleaned up leftover CSS comment referencing the removed "Visible to others" status bubble

## Deploy
- [ ] Commit & push to GitHub
- [ ] Deploy to Render (autoDeploy)
- [ ] Verify live at https://hellobye-chat.onrender.com/
- [ ] Ensure no data deleted/removed
