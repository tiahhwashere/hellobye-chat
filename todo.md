# Round 7 — UI Text Polish, Notifications & Media Revamp

## Investigation
- [x] Find "Log out of hellobye?" confirm text — index.html:6283
- [x] Find status bubble tooltip — index.html:6716 ("Shown to others as a bubble...")
- [x] Find privacy description — index.html:6736 ("Others can only see your picture...")
- [x] Find chatroom msg system notif — index.html:9596 showNotification() on every chatroom msg
- [x] Find groupchat msg notif — group-message handler (9959) has NO showNotification (only playMessageSound) — but still noisy; will ensure clean
- [x] Find DM open/close toast — closeConversation toast at 12711; openDM has no toast (already clean). DM-receive already badge-only.
- [x] Find "Use at least 6 characters..." — index.html:6918
- [x] Find "Send in Direct Message" — index.html:14326
- [x] Find video rendering — createFileElement (10401) + .message-file video CSS (1436) + media-send-preview (4143)
- [x] Find image rendering — .message-file img CSS (1422) max 480px; mobile 320px
- [x] Find mention system — highlightMentions/extractMentions (8345); chat autocomplete (10720); DM autocomplete (13920); NO group autocomplete; server ping emit public(3442)+dm(3571), NO group ping emit
- [x] Find reply system — startReply/cancelReply (14465); startDMReply (14489); startGroupReply (13174); createReplyQuote (14515) with jump-to-msg

## Implementation
- [x] Change "Log out of hellobye?" → "Are you sure you want to log out"
- [x] Rewrite status bubble tooltip text (professional)
- [x] Rewrite privacy description text (professional)
- [x] Remove system notification for chatroom messages (keep DMs)
- [x] Remove system notification for groupchat messages (keep DMs)
- [x] Remove toast on DM open/close
- [x] Rewrite "Use at least 6 characters..." (professional)
- [x] Rewrite "Send in Direct Message" (professional)
- [x] Revamp video sending format (better UI when sending video from files)
- [x] Make images a bit smaller
- [x] Revamp/advance user pinging/mentions system (group autocomplete + group ping/mention server emit + handlers)
- [x] Revamp/advance reply system (hover preview tooltip with sender avatar + full message)

## Deploy
- [x] Syntax check (server.js + inline JS in index.html)
- [x] Local boot test
- [x] db.json untouched (no data removed)
- [ ] Commit + push to GitHub
- [ ] Verify Render deploy live
- [ ] Confirm all features on live site
