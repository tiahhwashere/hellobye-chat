# Hellobye-Chat — Round 6: Member List Bubble Size/Overlay + Mobile Layout

## Context
User feedback: "fix the status messages on the member lists that looks a bit too big and overlying the users profile picture and fix the mobile layout if broken or sizes are too big"
- Round 4 aligned the member list orb with the avatar's LEFT edge (margin-left: -49px), causing the bubble to overlay the avatar
- Also need to audit/fix mobile layout (sizes too big or broken)

## Tasks
- [x] A. Update todo.md for Round 6
- [x] B. Investigate member list bubble on live site (measurements + screenshots)
- [x] C. Fix member list bubble: compact CSS applied (margin-left:0, 20px orb, 12px font, 3px/10px padding) — no longer overlays avatar
- [x] D. Audit mobile layout (390/768/360px: chat, settings, profile view, header, input — no h-overflow; found clipped chat-header title at ≤480px)
- [x] E. Fix mobile issues: chat-header-text h3 ellipsis truncation at ≤480px (was hard-clipped at 195px)
- [ ] F. Verify fixes visually with fresh CSS (local server, desktop + mobile viewport)
- [ ] G. Commit & push to GitHub
- [ ] H. Wait for Render autoDeploy & verify live
- [ ] I. Ensure no data deleted/removed
