# Request AY — remote speaking ring + downloadable PC app + soft update

## A. Remote speaking ring (green circle for OTHER people)
- [x] Verify server relays voice-speaking/voice-state to all room members
- [x] Add client-side remote VAD fallback (analyse remote audio streams)
- [x] Ensure voiceUpdateTile reliably toggles .speaking ring for remote users
- [x] Test multi-speaker ring logic (hysteresis + per-peer analyser)

## B. Downloadable PC file (desktop app)
- [x] Build Electron desktop wrapper for the website
- [x] Package into a downloadable file (portable exe)
- [x] Host the file and get a public link (GitHub Release)
- [x] Add /download page + in-app download buttons

## C. Soft update for PC version
- [x] PC app detects when website has been updated (/api/version poll)
- [x] Show soft update banner / perform soft update

## D. Verify + deploy
- [ ] Syntax check + smoke test, no data loss
- [ ] Commit + push + verify Render deploy live
- [ ] Provide file link in chat
