# Round 4 — Admin reset-name, BG scale UI, accent icon removal, revamped Current Accent

## Tasks
- [x] 1. Admin panel "Rename a User": added "Reset Name" button + /api/admin/reset-name endpoint; resets to reset_user_XXXXXXX with random unique 7-digit number (refactored migrateUsername helper, collision-checked)
- [x] 2. Removed the picture/image icon from the Chat Background card header
- [x] 3. Chat Background scale UI now matches the Adjust Profile Picture scale UI (grouped dark cards, uppercase labels, pill value badges, accent-colored thumb sliders)
- [x] 4. Removed the painting icon from the Website Accent Color card header; revamped Current Accent with advanced UI (large gradient swatch, hex, RGB chips, HSL readout, readability meter, live preview tiles)
- [ ] 5. Commit, push, deploy, verify (no data wiped)
