# Round 8 — Right-Click Copy Message + UI Overlap/Bug Fixes

## Investigation
- [x] Find existing right-click context menu system (chatroom + DM + group messages)
- [x] Identify all context menus / dropdowns / overlays that could overlap
- [x] Find existing copy functionality (if any)
- [x] Audit z-index stacking of all overlays/modals/dropdowns/tooltips
- [x] Find delays/bugs in menus, tooltips, autocomplete, reply preview

## Implementation
- [x] Add "Copy Message" option to chatroom message right-click menu
- [x] Add "Copy Message" option to DM message right-click menu
- [x] Add "Copy Message" option to group message right-click menu
- [x] Implement copy-to-clipboard helper (text fallback)
- [x] Fix any overlapping UI (z-index, positioning, collision)
- [x] Fix delays/bugs (debounce, timing, transition issues)
- [x] Ensure menus blend visually with existing design

## Deploy
- [x] Syntax check (server.js + inline JS)
- [x] Local boot test
- [x] db.json untouched
- [ ] Commit + push to GitHub
- [ ] Verify Render deploy live
- [ ] Confirm features on live site
