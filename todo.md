# DM Toggle Fix Tasks

## Analysis
- DM toggle saves and enforces correctly (verified on live site)
- Issue 1: Profile view modal doesn't re-render DM button live when DM state changes
- Issue 2: "Messages Unavailable" text is unprofessional
- Issue 3: DM disabled banner text needs professionalizing

## Tasks
- [x] Add live profile-view DM button update in `profile-updated` handler
- [x] Professionalize "Messages Unavailable" button text + tooltip in `renderProfileView`
- [x] Professionalize DM disabled banner text in `applyDMDisabledState`
- [x] Professionalize context menu "Send Message" toast error text
- [x] Professionalize toggle change handler toast text
- [x] Professionalize server-side dm-send error messages
- [x] Add `currentProfileViewUser` tracking + `closeProfileView()` helper
- [x] Add `updateProfileViewDMButton()` for live DM button updates
- [x] Add `.dm-disabled-btn` CSS for professional muted button style
- [x] Verify JS syntax is valid (node -c) - both index.html and server.js
- [ ] Commit and push to GitHub (auto-deploys to Render)
- [ ] Verify deployment live
