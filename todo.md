# Request BE — mini player, screenshare picker, perf, desktop menu

## A. Floating mini player (PiP) for screenshare/camera
- [x] Show floating video when stage hidden (other channel/server or hide call view)
- [x] Draggable, expand/close, works for screenshare AND camera

## B. Custom screenshare source picker UI
- [x] In-app modal asking which POV (entire screen / window / tab) instead of native-only
- [x] Pass displaySurface hint to getDisplayMedia

## C. Fix lag/delay
- [x] Skip full grid rebuild when structure unchanged (signature check)
- [x] Throttle local + remote VAD loops to ~25fps

## D. Camera fully off when toggled off
- [x] Stop all tracks + clear srcObject so device LED turns off

## E. Desktop app: custom menu bar UI
- [ ] Replace native File/View/Edit/Help with custom in-app buttons + dropdowns
- [ ] Remove "Toggle Developer Tools" + remove whole "Edit" menu

## F. Desktop app: rename title
- [ ] "shhh - no one has to know" -> "Hellobye"

## G. Verify + deploy
- [ ] node --check + inline JS check
- [ ] Commit + push + verify Render deploy live
