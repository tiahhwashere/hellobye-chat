# Mobile UI + Panel Color Rings + Status Message Fixes

## Goal
Five separate fixes:
1. Mobile UI not spaced/smushed together
2. Remove circle color rings from mini profile picture, full profile settings picture,
   and everyone else's profile picture (profile view) when a Panel Theme Color is chosen
3. Chatroom placeholder: change "Type a message" → "Message"
4. Status Message must be well set up (proper layout)

## Tasks
- [x] Inspect mobile CSS / media queries for spacing issues
- [x] Inspect avatar circle/ring styling in mini profile, full profile, profile-view
- [x] Find "Type a message" placeholder(s) in chatroom
- [x] Find Status Message rendering/layout code
- [x] Fix mobile spacing (media queries)
- [x] Remove color circle rings from mini profile avatar (applyMiniProfileColor)
- [x] Remove color circle rings from full profile avatar (applyProfileColor)
- [x] Remove color circle rings from profile-view avatar (applyProfileViewPanelColor)
- [x] Change chatroom placeholder "Type a message" → "Message"
- [x] Fix Status Message layout
- [x] Verify visually in browser (mobile + desktop)
      Fix 1 (Mobile spacing): PASS — nav font-size 10px, padding 10px 6px
      Fix 2 (Avatar rings): PASS — all 3 avatars box-shadow none / no colored border
      Fix 3 (Placeholder): PASS — "Message"
      Fix 4 (Status msg): PASS — name display:block, bubble margin-top 8px, text shows
- [ ] Commit & push to GitHub (ONLY index.html — NOT db.json)
- [ ] Trigger Render deploy & verify live site
- [ ] Confirm no data wiped
