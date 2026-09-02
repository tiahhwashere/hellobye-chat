# Hellobye-Chat — Round 4: Dream Bubble Alignment Fix

## Tasks
- [x] A. Investigate dream bubble alignment on live site (member list + profile view)
  - Measured: In member list, orb starts at text left edge (x=77), avatar at x=18 — orb is 59px right of avatar
  - Measured: In profile view, orb starts at text left edge (x=640.5), avatar at x=452.5 — orb is 188px right of avatar
  - Conclusion: Dream bubble orb does NOT align with the avatar/profile picture; it only aligns with the text
- [x] B. Fix dream bubble alignment in member list so orb aligns with avatar
  - Added --hb-avatar-w and --hb-gap CSS variables to .user-item (default: 38px, 11px)
  - Added margin-left: calc(-1 * (var(--hb-avatar-w) + var(--hb-gap))) to .user-info .status-msg-bubble
  - Overrode variables in breakpoints: ≥1100px (46px, 13px), ≤768px (34px), ≤480px (32px)
  - Changed .user-info overflow: hidden → visible (text elements have own overflow: hidden)
- [x] C. Fix dream bubble alignment in profile view so orb aligns with avatar
  - Added --pv-avatar-w and --pv-gap CSS variables to .profile-view-main (default: 168px, 20px)
  - Changed .pv-name-sm margin-left from 0 to calc(-1 * (var(--pv-avatar-w) + var(--pv-gap)))
  - Overrode variables in breakpoints: ≤768px (120px, 14px), ≤480px (92px, 12px), ≤360px (80px, 10px)
  - Changed .profile-view-info overflow: hidden → visible (also fixes pv-copy-id-menu dropdown clipping)
- [x] D. Delete test_bubble.html (cleanup before deploy)
- [x] E. Verify alignment fix on live site via JS injection (orb left edge = avatar left edge, diff=0 in both contexts)
- [x] F. Commit & push to GitHub (commit 7407ef7)
- [x] G. Wait for Render autoDeploy & verify live
  - Deploy status: live (finished at 09:10:10)
  - Verified member list: avatarLeft=18, orbLeft=18, diff=0 ✓
  - Verified profile view: avatarLeft=452.5, orbLeft=452.5, diff=0 ✓
  - CSS variables present on live site: --hb-avatar-w=46px, --pv-avatar-w=168px ✓
- [x] H. Ensure no data deleted/removed (only CSS changes, no data modifications)
