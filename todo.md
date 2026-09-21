# Request BJ — free invite codes, Create Role UI, remove SVGs, revamp UIs, bigger role icons

## 1. Free up custom invite codes when changed/removed
- [x] Backend: prune expired invites so codes free up
- [x] Backend: isInviteCodeTaken only counts live invites
- [x] Backend: same-server re-claim refreshes instead of erroring
- [x] node --check server.js

## 2. Create Role UI — make role options visible & better
- [x] Replace tabbed perm-shell with fully-visible grouped layout
- [x] Verify inline JS (checkjs.py)

## 3. Remove SVG icon from Leave Server + Delete webhook UIs
- [x] Remove wh-del-mark from leave-server-modal
- [x] Remove wh-del-mark from wh-delete-modal
- [x] Remove associated CSS

## 4. Revamp Preferences, Channels, Invites, Server Overview UIs
- [x] Revamp Preferences pane (pref-rows)
- [x] Revamp Channels pane (grouped list)
- [x] Revamp Invites pane (create card + list)
- [x] Revamp Server Overview pane (hero)

## 5. Bigger role icons (Assign Roles, profile, chat, members list)
- [x] Increase badge sizes in CSS
- [x] Add badge image to Assign Roles rows

## 6. Verify + deploy
- [ ] node --check server.js
- [ ] python3 checkjs.py servers.html
- [ ] git commit + push
- [ ] Render deploy + verify live
