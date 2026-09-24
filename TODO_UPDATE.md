# HelloBye Update — Todo

## 1. PC/Desktop: remove installer from Downloads on full-app delete
- [x] Add Downloads-folder installer file targets to scheduleSelfDelete (main.js)

## 2. Loading screen: make bar wider (left→right)
- [x] Widen splash.html .bar span (40%→66%, slide keyframe)

## 3. PC/website icons: de-cartoon "Create a server", "Join a server", "Back to main chat"
- [x] Replace SVGs in servers.html with cleaner line icons

## 4. Voice messages: fix embed not playing/pausing + waveform missing at start
- [x] Fix instant waveform (rAF redraw + ResizeObserver + brighter unplayed bars) in index.html + servers.html
- [x] Fix play/pause click handling (preventDefault/stopPropagation)

## 5. @here / @everyone embed: pink -> dark grey
- [x] Recolor mention embed + chips in servers.html

## 6. Notification red dot: bright red dot + ping count number
- [x] Static bright-red count badge + increment logic in servers.html

## 7. PC: offer "log back in with last account" after new build install
- [x] Persist last login (main.js carryover + preload.js + index.html welcome-back card)

## Ship
- [x] Bump desktop version (1.6.0 -> 1.6.1)
- [x] Build NSIS + portable, publish GitHub release desktop-v1.6.1
- [x] Update server.js DESKTOP_FALLBACK + download.html to v1.6.1
- [x] Commit + push to GitHub master
- [x] Render deploy live (dep-daqor2jbc2fs739jqe40) + verified live endpoints
