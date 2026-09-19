# Round 9 Tasks

## 1. Members List Background UI — make wider
- [x] Locate the panel/modal container CSS for Members List Background
- [x] Increase its width (540px -> 700px; URL sub-modal 440px -> 520px)

## 2. Account Settings — add search button per tab
- [x] Examine `.settings-v2-shell` structure and each tab's content
- [x] Add a search input at the top of each tab that filters setting options
- [x] Row-level filtering + highlight + empty state + clear button

## 3. Reset Password — username + password form
- [x] Replace the "contact administrator" modal text with a username + password form
- [x] Verify credentials via /api/login before logging user back in
- [x] Show error if credentials are wrong
- [x] Handle disabled account + 2SV branches

## 4. Deploy & Verify
- [x] Syntax check
- [ ] Commit & push to GitHub master
- [ ] Verify Render deploy live
- [ ] Confirm no data wiped
