# Fix Mini Profile Panel Theme Color Blending

## Goal
When users change the Panel Theme Color, the "middle part" of the mini profile
(and full profile + profile-view of other users) should NOT turn grey / overlap
or fail to blend — every part of the UI should blend with the chosen color.

## Tasks
- [x] Clone & inspect repo; locate mini profile, full profile, profile-view code
- [x] Understand existing panel-color application functions
- [x] Run server locally and reproduce the grey/overlap bug visually
- [x] Identify the exact elements causing the grey "middle part"
      ROOT CAUSE: applyProfileViewPanelColor() uses hardcoded rgba(0,0,0,...)
      black overlays for inner cards (bio, status, extra, banner placeholder,
      copy-id buttons, action buttons) instead of color-derived blends like
      blendOverlay(). Mini profile & full profile already use blendOverlay and
      blend correctly. The grey "middle part" appears in the OTHER-user profile
      view, especially with light Panel Theme Colors.
- [x] Fix profile-view (other users) so colors auto-blend using blendOverlay
      Replaced hardcoded rgba(0,0,0,...) card backgrounds with blendOverlay()
      and hardcoded #ffffff text with readableText() (luminance-aware).
      Fixed updateProfileViewDMButton() too.
- [x] Double-check full profile (ui/fullprofile) blends with light colors
      Confirmed: green #57F287 -> dark text, blendOverlay cards. Already correct.
- [x] Re-verify mini profile blends with light colors
      Confirmed: uses readableText + blendOverlay. Already correct.
- [x] Verify fix visually in the browser (mini + full + other user view)
      Light yellow #FEE75C: cards=rgba(208,189,75,0.85) yellow-tinted, text=dark ✓
      Dark blue #5865F2: cards=rgba(118,129,244,0.85) blue-tinted, text=white ✓
      NO grey rgba(0,0,0,...) backgrounds remain on inner cards.
- [ ] Commit & push index.html to GitHub (ONLY index.html — NOT db.json)
- [ ] Trigger Render deploy & verify live site
- [ ] Confirm no data wiped
