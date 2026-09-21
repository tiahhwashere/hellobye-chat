# Request AW — voice channels + better embeds + real-time voice sync

## A. Voice message embed polish
- [x] Better voice-wave layout in the recorder panel (smoother, more polished)
- [x] Custom, better voice-message embed UI (in-chat player redesign)
- [x] Fix lag/delay inside the voice-message embed (instant playback, no decode wait)

## B. GIF / link embed UI
- [x] Make GIF embed UI better + less cartoony
- [x] Make link embed UI better + less cartoony

## C. Voice channels (server)
- [x] Server: support channel `type: 'voice'` (create/rename/delete/reorder)
- [x] Edit Channel / Add Channel UI: add "Voice Channel" option
- [x] Render voice channels in the sidebar with a speaker icon
- [x] Clicking a voice channel joins a voice call (not text chat)

## D. Voice call system
- [x] Real-time voice call via WebRTC (mesh) + Socket.io signaling
- [x] Mute / Unmute / Deafen controls + leave
- [x] Voice call settings/options (input device, output volume, etc.)
- [x] Show member profiles inside the voice channel (avatars in the call)
- [x] Green speaking ring around avatar when a user talks (real-time VAD)
- [x] Fix all voice chat / voice message lag — everything synced in real time

## E. Verify + deploy
- [ ] Syntax check + local smoke test, no data loss
- [ ] Commit + push + verify Render deploy live
