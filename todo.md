# Request BM — Invite embeds, server-only profile, Server Identity UI, VC presence, status dots, toast revamp

## 1. Invite / custom invite link embeds (public chat, groupchats, DMs)
- [x] Show `./code` short link for custom invites in the embed
- [x] Show server icon, banner, member count, ONLINE count, channels, bio, owner
- [x] Detect custom short codes (4-40 chars) in `extractServerInviteCode`
- [x] Verify embed renders in public chat (verified: `./ninja` chip + counts + owner)

## 2. My Server Profile = SERVERS ONLY (must not affect main chat)
- [x] Add clear "Servers Only" labelling
- [x] Stop mirroring server avatar onto the account-wide avatar
- [x] Stop writing global profile fields from this editor
- [x] Keep server-specific nickname/bio/avatar/banner/scales working
- [x] Verified: banner shows "Servers Only — these changes apply to Test Server and never to your main chat profile."

## 3. Server Identity UI — fix bio + fields not showing (size/clipping)
- [x] Make the My Server Profile modal body scroll so nothing is clipped
- [x] Verify Server Identity media block + bio + all fields visible
- [x] Verified: modal scrollHeight 1098 > clientHeight 729, overflow-y auto; bio + nickname visible

## 4. Voice-chat presence in member list + profile
- [x] Server: broadcast which users are in which voice channel to all server members
- [x] Client: track voice presence map
- [x] Member list: show "In voice" indicator + channel name
- [x] Member profile: show "In voice — #channel" detail
- [x] Only show for users sharing the same server
- [x] Verified: member row + profile both show "In voice — Voice"

## 5. Fix member-list status circle proportions (online/idle/dnd/offline)
- [x] Regenerate status icons as clean, consistent, professional circles
- [x] Fix sizing/position in the member list
- [x] Verified: clean green dot at correct proportion

## 6. Revamp ALL toast UIs (non-cartoony, unique, aligned with site)
- [x] Redesign toast CSS in index.html
- [x] Redesign toast CSS in servers.html
- [x] Update toast JS markup to match
- [x] Verify visually (both index.html + servers.html)

## 7. Verify + deploy
- [x] node --check server.js
- [x] JS syntax check servers.html + index.html
- [x] Visual verification of all changes
- [ ] git commit + push
- [ ] Render deploy + verify live
