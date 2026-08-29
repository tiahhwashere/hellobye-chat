# Hellobye Chat Update Tasks — Round 32

## 1. Desktop notifications toggle — fix double notification
- [x] When "Enable desktop notifications" is toggled, the test notification fires twice. Fix so it fires only once.

## 2. Search Messages UI — fade out on X click
- [x] Add a fade-out animation when the X (close) button is clicked on the Search Messages panel.

## 3. Members List Background — unsaved changes + discard
- [x] If user has NOT clicked "Apply background", show the "You have unsaved changes" UI.
- [x] If user clicks discard, revert the background back to the previously-applied state.

## 4. Message/GIF/video/image embed — less cartoony, modern, better layout
- [x] Revamp the message embed/media layout to be very modern and clean (not cartoony).

## 5. Members tab — open/close conversation syncs with Messages tab
- [x] When "Open conversation" is clicked from the Members tab, add the conversation to the Messages tab.
- [x] When "Close conversation" is clicked, also remove it from the Messages tab.

## 6. Deploy
- [x] Commit and push to GitHub (commit ddb377a pushed to master)
- [x] Deploy/update on Render (autoDeploy triggered, deploy dep-da9fhnbl live)
- [x] Verify at https://hellobye-chat.onrender.com/ (HTTP 200, Round 32 code confirmed)
