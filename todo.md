# Music Player Feature — Implementation Plan

## Tasks
- [x] Examine current Notifications & Appearance settings structure
- [x] Examine server-side preferences endpoint and data model
- [x] Examine existing CSS patterns and design variables
- [ ] Add Music Player HTML section to Notifications & Appearance tab (after Appearance section)
- [ ] Add professional Music Player CSS (player card, controls, artwork, progress bar, song info)
- [ ] Add JavaScript: link parsing (Spotify/SoundCloud/YouTube/Apple Music/Deezer), embed generation, play/pause/loop/volume controls, song metadata display, save link to preferences
- [ ] Update server.js preferences endpoint to persist musicLink
- [ ] Update fullUser() to expose musicLink to client
- [ ] Wire up save/load logic for music link in JS
- [ ] Verify JS syntax with node -c
- [ ] Commit, push to GitHub, verify Render deploy goes live
- [ ] Verify feature works on production URL
