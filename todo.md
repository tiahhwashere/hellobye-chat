# Hellobye-Chat — 2SV Code: No Auto-Expiry

## Context
User request: "for the 2-Step Verification whenever the Next Auto-Regen is due now do NOT expire the last code keep it active and let users use it to login until they generate another code then make the old one invalid and the new one valid"

## Changes Needed
- [x] server.js: Remove 48h cooldown on /api/settings/2sv/regenerate — allow regeneration anytime
- [x] server.js: Remove/disable refresh2SVCode auto-regeneration (keep function but make it a no-op or remove)
- [x] server.js: Update /api/settings/2sv/status — remove nextRegenAt or repurpose it (no more auto-regen deadline)
- [x] server.js: Update regenerate endpoint message — no more "once every 48 hours" text
- [x] index.html: Update 2SV description text — remove "automatically refreshes every 48 hours, at which point the previous code becomes invalid"
- [x] index.html: Remove/repurpose "Next Auto-Regen" countdown — replace with "Code Age" or remove the cooldown-based button disabling
- [x] index.html: Regenerate button should always be enabled (no cooldown)
- [x] index.html: Update regenerate prompt text — remove "limited to once every 48 hours"
- [x] Syntax check both files
- [x] Test locally (API + browser UI verified)
- [x] Restore db.json, commit, push, deploy, verify live
