# Make circle/ring around all profile pictures transparent

## Goal
Make the border/ring (circle) around ALL users' profile pictures transparent across the entire app.

## Avatar elements with borders to make transparent
- [x] .message-avatar — border: 1px solid transparent
- [x] .mention-dropdown-avatar — border: 2px solid transparent
- [x] .mention-tooltip-avatar — border: 2px solid transparent
- [x] .search-result-avatar — border: 1px solid transparent
- [x] .profile-v2-avatar (override) — border: 4px solid transparent
- [x] .profile-avatar-large (base) — border: 4px solid transparent
- [x] .profile-view-avatar (base) — border: 6px solid transparent
- [x] .profile-view-avatar (refined ring override at line 3939) — border-color: transparent
- [x] .mini-profile-avatar — border: 2px solid transparent + box-shadow: none
- [x] .dm-header-avatar — border: 2px solid transparent
- [x] Status-dot borders (all variants) — transparent
- [x] JS box-shadow rings on avatars — already set to none
- [x] JS status-dot border-color in applyMiniProfileColor — transparent

## Tasks
- [x] Make all CSS avatar borders transparent
- [x] Make status-dot borders transparent
- [x] Remove/neutralize JS box-shadow rings on avatars
- [x] Verify visually (screenshots confirm no rings/borders)
- [ ] Commit & push to GitHub (ONLY index.html — NOT db.json)
- [ ] Verify Render deploy & live site
- [ ] Confirm no data wiped
