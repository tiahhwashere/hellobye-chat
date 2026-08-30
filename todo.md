# Revamp Panel Theme Color UI — new tabbed style/system

## Tasks
- [x] 1. Design & add new CSS for the tabbed Color Studio system (tabs, panels, RGB sliders, preset grid)
- [x] 2. Rebuild the full-profile Panel Theme Color HTML markup with the tabbed system (Wheel / Swatches / Sliders tabs)
- [x] 3. Rebuild the mini-popover Panel Theme Color HTML markup (compact tabbed version)
- [x] 3b. Clean up old mini-accent-row / mini-accent-revert CSS that's now unused
- [x] 4. Add JS: tab switching + RGB slider logic + new swatch grid rendering (categorized groups) + RGB<->hex sync
- [x] 4b. Update wheelPickColor + applyMiniProfileColor + applyProfileColor to sync new UI elements (preview swatch, hex, RGB sliders, swatch active)
- [x] 4c. Restore Website Accent Color CSS (.accent-preset, .accent-current-row, etc.) that was accidentally removed
- [x] 5. Wire up the new UI to the existing save/sync flow (studioPickColor unified handler). Cross-sync between full profile & mini popover.
- [x] 6. Verify JS syntax with node --check
- [x] 7. Commit & push ONLY index.html (NOT db.json) — commit 2118eb8 pushed
- [x] 8. Verify Render deploy & live site — deploy dep-daa5a1ek is live, new CSS classes confirmed on live site

## Constraints
- DO NOT modify or push data/db.json (preserve all user data) ✓ db.json untouched
- Only commit index.html ✓ only index.html committed
