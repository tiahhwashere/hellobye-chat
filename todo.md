# Request BA — voice chat text chat + 30-person limit + GIF-avatar-on-speak

## A. Voice channel text chat (beside voice settings)
- [x] Server: `voice-chat-send` handler relays to voice room (ephemeral)
- [x] Frontend: toggle button, panel HTML, CSS, JS (send/render/unread)
- [x] Socket wiring: `voice-chat-message` handler
- [x] Clear chat on join/leave

## B. 30-person voice limit
- [x] Server: `VOICE_MAX_PEOPLE = 30` + full check in `voice-join`
- [x] Client: shows server error toast on full

## C. GIF avatar animates only when speaking (VC only)
- [x] CSS: static canvas default, animated img only under `.speaking`
- [x] JS: `voiceAvatarHtml` + `voicePaintGifStatic` first-frame capture
- [x] Wire into `voiceRenderStage`

## D. Verify + deploy
- [x] Syntax check server.js + inline JS
- [ ] Commit + push + verify Render deploy live
