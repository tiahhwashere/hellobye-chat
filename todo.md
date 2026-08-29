# Round 14 — Show "You have unsaved changes" when profile picture/banner is changed but not saved

## Implementation
- [x] Mark `profileDirty = true` after a successful avatar upload (in `uploadProfileImage` success path) so the unsaved-changes guard fires on navigation
- [x] Mark `profileDirty = true` after a successful banner upload (same function — covers both types)
- [x] Mark `profileDirty = true` after avatar remove (remove button handler)
- [x] Mark `profileDirty = true` after banner remove (remove button handler)
- [x] Ensure the unsaved-modal "Save" path (saveProfileNow) still clears profileDirty so the flow works end-to-end

## Deploy
- [x] Syntax-check index.html (script blocks, 0 errors)
- [ ] Commit + push to GitHub master
- [ ] Render auto-deploy goes live
- [ ] Verify site online (no data wipe) + edits grep-confirmed live
