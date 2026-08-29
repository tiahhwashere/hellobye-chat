# Round 30 — To-Do

## Explicit Changes Requested
- [x] 1. Remove the DM cooldown entirely (backend `dm-send` handler + frontend indicators/checks)
- [x] 2. Change group chat cooldown from 3 seconds to 0.3 seconds (backend `group-send` handler + frontend)
- [x] 3. Visually disable the "Disable Account" button for @lore (the owner) — disabled attribute + styling, not just a toast
- [x] 4. Fix/patch all bugs found during audit:
  - Removed dead `lastDMTime` declaration (no longer used)
  - Removed dead `startDMCooldown` function + `dmCooldownEnds`/`dmCooldownTimer` vars + DM cooldown indicator HTML + CSS
  - Fixed `startGroupCooldown` to handle sub-second (0.3s) cooldowns with `setTimeout` + universal clear (clearTimeout+clearInterval) to avoid timer-type mismatch
  - Updated admin panel cooldown-exempt description (DMs no longer have a cooldown; chatroom=3s, group=0.3s)
- [ ] 5. Commit + push to GitHub
- [ ] 6. Verify Render deploy + live site
