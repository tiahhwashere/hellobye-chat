# HelloBye Update 10 — Todo

## 1. Roles & Badges: bigger on profile + show on servers page & servers VC
- [x] index.html: bigger `.user-badge-icon` on profile (#pv-handle)
- [x] server.js: expose global `badges` on server members
- [x] servers.html: render badge icons in members list (memberRowHtml)
- [x] servers.html: render badge icons in VC tiles (vs-tile)

## 2. Voice bug: stopping screen share / turning off camera kills voice
- [x] Rebuild WebAudio gain graph when remote audio stream changes (voiceEnsureRemoteAudio)
- [x] Health-check recovery for audio graph

## 3. Screen share audio bug: hearing own voice when others share
- [x] acquireScreen: video only (no system audio)
- [x] voiceStartScreenShare: transmit video track only

## 4. Deleted/disabled accounts removed from servers members list
- [x] server.js: purge on delete-account
- [x] server.js: purge on disable-account (+ stash memberships)
- [x] server.js: startup self-heal purge
- [x] server.js: filter missing/disabled members out of publicServer
- [x] server.js: restore memberships on reactivate

## 5. "Return to call" when leaving VC to main chat
- [x] rail-home: keep call, minimise + show Return to call above profile
- [x] attention animation on the bar

## 6. Voice chat background: any custom color + effects
- [x] color picker UI in Voice chat background section
- [x] apply custom colour to voice stage effects (--accent-rgb override)
- [x] persist in prefs

## 7. Revamp "Create a server" SVG icon (professional)
- [x] Redesign SVG (rail + hero)

## 8. PC build update
- [x] Bump version to 1.8.0
- [ ] Build + release
- [ ] Update server fallback + download page

## Ship
- [ ] Commit + push to GitHub
- [ ] Verify Render deploy + live endpoints
