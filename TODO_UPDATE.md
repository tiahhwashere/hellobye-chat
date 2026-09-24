# HelloBye Update 2 — Todo

## 1. @everyone / @here ping: white -> darkish blue
- [x] Recolor mention-everyone/here chips + mention-ping embed to dark blue (servers.html + index.html)

## 2. Carry over Members List Background + Chat Background on welcome-back login
- [x] Extend carryover (main.js/preload.js) to store user prefs (members bg, chat bg, accent, theme)
- [x] index.html: save prefs into carryover + restore them on "Continue as @user"
- [x] Hook hbPersistCarryover() into saveMembersBgState() + saveBgSettings()

## 3. Revamp Members List Background UI
- [x] Redesign members-bg modal (header, live mock preview, segmented source, tint presets, sliders, buttons)

## 4. Better Create/Join server icons (not cartoony, matches website)
- [x] Redesign rail + hero SVGs in servers.html (server-rack+plus / enter-door)

## 5. Better link embeds with more details
- [x] server.js /api/embed: richer metadata (type, published date, video, section, site, reading time, keywords, favicon, locale)
- [x] index.html renderEmbed: richer card (type badge, author, date, reading time, section, tags, domain)

## Ship
- [ ] Bump desktop version (1.6.1 -> 1.6.2)
- [ ] Build + publish desktop release
- [ ] Update server.js fallback + download.html
- [ ] Commit + push to GitHub
- [ ] Trigger Render deploy + verify live
