# Round 24 — Revert UI, keep only group chat

## Task 1: Capture the group chat code from current Round 23 state
- [x] Extract all group chat server.js additions (publicGroup, findGroup, 8 endpoints, 4 socket handlers, cleanup, migration, defaultDB groupChats)
- [x] Extract all group chat index.html additions (plus button, create modal, settings modal, group overlay HTML, CSS, all JS)

## Task 2: Reset both files to Round 22 (commit 964fdc0) — reverts image zoom + admin UI overhaul
- [x] git checkout 964fdc0 -- index.html server.js

## Task 3: Re-apply ONLY group chat server.js changes onto Round 22 server.js
- [x] Add db.groupChats to defaultDB + migration guard
- [x] Add publicGroup() + findGroup() helpers
- [x] Add all 8 group API endpoints
- [x] Add 4 group socket handlers
- [x] Add group message purge to cleanup
- [x] Add group username migration
- [x] Syntax check server.js (PASS)

## Task 4: Re-apply ONLY group chat index.html changes onto Round 22 index.html
- [x] Add group-create-plus-btn CSS + HTML
- [x] Add group chip CSS
- [x] Add group-create-modal HTML
- [x] Add group-settings-modal HTML
- [x] Add group-overlay HTML
- [x] Add all group chat JS (state, create modal, load+render, openGroup, messages, send, socket listeners, settings, reply/edit/delete)
- [x] Add delete modal pendingDeleteGroup handling
- [x] Add renderDMList() -> renderMessagesList() delegation
- [x] Add loadGroupChats() calls (startup + switchSidebarView dms case)
- [x] JS parse check (PASS), server boot test (PASS)

## Task 5: Verify + Deploy
- [x] Syntax check both files (PASS)
- [x] Confirm image zoom + admin UI are reverted (back to Round 22 look)
- [x] Confirm group chat is intact
- [ ] Commit & push
- [ ] Verify Render deploy
