# HelloBye Update 11 — Todo

## A. Roles & Badges on the user's profile (not just the members list)
- [x] servers.html: render global badge icons in `renderMemberProfileBody` (member profile modal)
- [x] servers.html: CSS `.member-profile-name .srv-badge-icon`

## B. Chat background custom image quality — clearer (was "staticish")
- [x] server.js: raise enhance target to 3840 + enable sharpening for `/api/servers/:id/chat-background`

## C. Voice / music embed waveform → pink to greyish
- [x] servers.html: `vpWaveFill()` pink→grey gradient helper
- [x] servers.html: apply to `vpDrawWave` (voice/music embeds)
- [x] servers.html: apply to `srvVoiceDrawWave` (voice recorder)

## D. Ping notification → red dot on channel (no toast, no blinking)
- [x] servers.html: `server-ping` handler sets `channelRedPings`, removes toast
- [x] servers.html: remove `pingPulse` blinking animation from ping dots
- [x] servers.html: red dot clears when the channel is opened (openChannel)

## E. Return to call
- [x] servers.html: rail-home handler no longer shows the "Call kept running" toast
- [x] servers.html: return-to-call bar shows above the user's mini profile
- [x] servers.html: bar labelled "Return to call"; click returns to that server's VC

## Ship
- [x] Local smoke test (server boots, serves edited files, enhance verified)
- [x] Commit + push to GitHub
- [x] Verify Render deploy live (no data wipe)
