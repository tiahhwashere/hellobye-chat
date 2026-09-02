# Hellobye-Chat — Round 5: Dream Bubble Position in Profile View

## Context
Round 4 aligned the dream bubble orb with the avatar's LEFT edge (margin-left: -188px).
User feedback: "fix the status messenger overlaying in the middle of the profile picture make it a little to the right bottomish of the profile picture"
The orb was overlapping the middle of the profile picture. Repositioned to bottom-right area.

## Tasks
- [x] A. Update todo.md for Round 5
- [x] B. Navigate to live site, open profile view, take screenshot + measurements to confirm overlap
  - Measured: orb left=453, avatar left=452.5 (orb at avatar's left edge, overlapping center)
  - Orb center at (468, 411), avatar center at (537, 349) — orb was in lower-left quadrant, overlapping avatar
  - Bubble body x=471-612 was entirely within avatar span (452.5-620.5)
- [x] C. Adjust `.pv-name-sm` CSS so the bubble sits near bottom-right of the avatar
  - Changed margin-left from calc(-1 * (var(--pv-avatar-w) + var(--pv-gap))) [-188px] to calc(-1 * var(--pv-avatar-w) * 0.30) [-50.4px]
    → orb now starts at ~70% across the avatar (right portion), not the left edge
  - Changed margin-top from 8px to max(8px, calc(var(--pv-avatar-w) / 2 - 53px))
    → positions orb near avatar bottom edge (31px for 168px avatar), clamped to 8px min for small avatars
  - Updated comments on .pv-name-sm and .profile-view-main
  - Responsive breakpoints already set --pv-avatar-w at 168/120/92/80px — formulas scale automatically
- [x] D. Verify visually via JS injection on live site
  - Orb center (605, 423), avatar center (537, 338), distance=109 > radius=84 (orb outside circle)
  - rightOfCenter=true, belowCenter=true — orb is at bottom-right of avatar
  - Body x=608-749 extends to the right past the avatar
  - Standalone test page confirmed "teal bubble positioned at lower right of profile picture"
- [x] E. Commit & push to GitHub
- [x] F. Wait for Render autoDeploy & verify live
  - Deploy status: live (finished at 09:31:52, commit 87b745b)
  - Verified live: cssMarginLeft=-50.4px, cssMarginTop=31px (new values present)
  - Orb center (605, 423), avatar center (537, 338), distance=109 > radius=84 (orb outside circle)
  - rightOfCenter=true, belowCenter=true (orb at bottom-right of avatar)
  - Body x=608-749 extends to the right past the avatar
- [x] G. Ensure no data deleted/removed (CSS margin values + comments only, no data modifications)
