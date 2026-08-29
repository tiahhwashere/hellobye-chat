# Round 44 — Panel Theme Color auto-blends with texts/placeholders/buttons in profile settings (mini + full)

## Goal
When a Panel Theme Color is chosen, the texts, placeholders, and buttons inside BOTH the mini profile popover and the full profile settings panel should automatically BLEND IN with the chosen color (cohesive tinted look), not just white-on-dark boxes.

## Tasks
- [x] 1. Inspect live site + repo state (Round 43 already deployed, identical to live)
- [ ] 2. Visually verify current blending state in browser
- [x] 3. Improve full-profile applyProfileColor() so inputs/placeholders/buttons blend with theme color (tinted variants)
- [x] 4. Improve mini-profile applyMiniProfileColor() likewise
- [x] 5. Syntax-verify the script block
- [x] 6. Boot-test server locally (HTTP 200, updated helpers present in served HTML)
- [ ] 7. Commit + push to GitHub (master)
- [ ] 7. Commit + push to GitHub (master)
- [ ] 8. Verify Render auto-deploy picks it up + live URL matches
