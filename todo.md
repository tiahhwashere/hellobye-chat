# Round 35: Revamp Message Bubble Chat UI

## Tasks
- [x] Revamp core message bubble CSS (bubble, avatar, sender, meta, actions, reply-quote, link-embed, file-embed, mention-highlight, replied-to-me)
- [x] Update large-screen media query override (line ~3735)
- [x] Update mid-range breakpoint (line ~3614 — no border-radius, inherits correctly)
- [x] Update mobile breakpoint (line ~4277) — asymmetric border-radius
- [x] Update second mobile breakpoint (line ~4589) — asymmetric border-radius
- [x] Update touch-device hover override (line ~4610) — background change
- [x] Verify compact mode override (line ~3785 — no border-radius, inherits correctly)
- [ ] Syntax-verify all `<script>` blocks
- [ ] Boot-test server (HTTP 200)
- [ ] Commit and push to GitHub
- [ ] Verify Render auto-deploy goes live
- [ ] Verify at https://hellobye-chat.onrender.com/
