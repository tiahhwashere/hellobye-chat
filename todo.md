# Request Z — Clickable @mention chips open the member profile

## 1. Make @username mentions clickable
- [x] `.mention-user` CSS: add `cursor: pointer`, hover state, transition
- [x] `linkify()`: render @username as `<span class="mention-user" data-mention-user="USERNAME" role="button" tabindex="0">`
- [x] Delegated `click` handler on `document` -> `openMemberProfile(uname)`
- [x] Delegated `keydown` (Enter/Space) handler for keyboard access

## 2. Verify & Deploy
- [x] node --check on extracted servers.html script
- [ ] Smoke test locally (servers.html 200 + markers present)
- [ ] Commit + push to GitHub master
- [ ] Trigger/verify Render deploy (no data wiped)
