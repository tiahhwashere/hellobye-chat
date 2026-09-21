# Request BL — Preferences readability, channel mentions, @here/@everyone red, wider settings, profile banner, unread dots, private profile cleanup, mobile, self-profile, invite embed details

## 1. Preferences tab: fix smushed/unreadable General, Access, Verification, Private, Slowmode, Notifications & Welcome, Welcome message
- [x] Improve layout/readability

## 2. Channel mentions (#chat) in chat + click to jump to channel
- [x] Detect #channel in messages, render as clickable, redirect on click

## 3. @here / @everyone for owner/admins: glowing yellow -> red notification
- [x] Change highlight color for owner/admin

## 4. Server Settings wider (left-to-right)
- [x] Increase modal width

## 5. Main chat profile preview: banner connects left/right/up (full-bleed)
- [x] Fix banner sizing in preview

## 6. Unread channel white dot beside channel name, clears on visit
- [x] Add unread indicator + clear logic

## 7. "This profile is private" UI: remove Location and Website
- [x] Remove those fields

## 8. Mobile client size adjusting support
- [x] Responsive fixes

## 9. Bottom-left profile click opens own profile
- [x] Wire self profile open

## 10. Invite link embed: ensure server icon/banner/bio/member count/join button show for custom + copy-paste links
- [x] Verify/fix embed for all link formats

## 11. Verify + deploy
- [x] node --check server.js
- [x] python3 checkjs.py servers.html
- [ ] git commit + push
- [ ] Render deploy + verify live
