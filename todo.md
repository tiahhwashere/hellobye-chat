# Round 27 Todo

## 1. Confirmation UI for "Leave this group chat?" (replace native confirm())
- [x] Build a custom modal confirmation UI (generic-confirm-modal + showGenericConfirm)
- [x] Replace the native confirm() in the Leave group button handler
- [x] Use the same confirmation UI for right-click leave (members) and delete (owner)

## 2. Fix "Add" button in Group Settings (blown out of proportion)
- [x] Fixed: added width:auto, proper padding, margin-top:0, min-width:0 on input

## 3. Change group chat member limit from 50 to 10
- [x] Updated server.js group-add endpoint (50 -> 10)
- [x] Added member limit check in group-create endpoint (max 10)
- [x] Added client-side limit in group create modal (max 9 additional)
- [x] Updated member count display to show "(N / 10)"

## 4. Fix "Clear" button on admin panel (blown out of proportion)
- [x] Fixed: added width:auto, margin-top:0 to the Clear button

## 5. Group chat image upload — show to all members
- [x] Backend already broadcasts group-updated to all members on icon upload
- [x] Frontend group-updated listener updates header + sidebar for all members
- [x] Added explicit updateGroupHeader + loadGroupChats after owner upload

## 6. Owner: change Leave button to Delete Group button with confirmation
- [x] renderGroupSettings shows "Delete Group" for owner, "Leave Group" for members
- [x] Added confirmation modal for delete with full warning text
- [x] Backend: added /api/groups/:id/delete endpoint that removes everyone

## 7. Owner: group name change — display for everyone
- [x] Backend already broadcasts group-updated on rename to all members
- [x] Frontend listener updates group name in header + sidebar for all

## 8. Right-click context menu on group chat (sidebar)
- [x] Members: right-click -> "Leave Group" with confirmation UI
- [x] Owner: right-click -> "Delete Group" with confirmation UI
- [x] Added "Open Group Chat" and "Group Settings" options too

## 9. Kick button in group settings — add a confirmation UI
- [x] Replaced native confirm() with showGenericConfirm modal for kick
- [x] Fixed kick button styling (proper padding, border-radius, white-space)

## 10. Deploy & verify
- [ ] Commit, push, verify Render deploy
- [ ] Test all features on live site
