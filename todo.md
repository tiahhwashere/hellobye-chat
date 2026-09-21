# Request AX — voice chat overhaul

## A. Remove emojis + layout
- [x] Remove 🔊 emoji from voice stage title
- [x] Make voice stage layout much better (not basic)

## B. Persistence across navigation
- [x] Keep voice call connected when switching servers
- [x] Keep voice call connected when switching channels
- [x] Fix bug where voice audio stops working

## C. Per-user context menu
- [x] Right-click a user in voice chat -> dropdown (deafen them, volume up, etc.)

## D. Volume + sync + quality
- [x] Default voice volume 150
- [x] Sync voice when more than one person talks
- [x] Ensure very clear voice quality

## E. Notifications + navigation guard
- [x] Change green notification number to red
- [x] "Go back to main chat" -> tell user they must leave VC first

## F. Voice Settings
- [x] Make Voice Settings UI more enhanced
- [x] Add mic test option in Voice Settings

## G. Verify + deploy
- [x] Syntax check + smoke test, no data loss
- [ ] Commit + push + verify Render deploy live
