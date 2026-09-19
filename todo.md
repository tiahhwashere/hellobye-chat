# Servers System — Build Plan

## 1. Backend (server.js)
- [x] Add `db.servers` + `db.serverInvites` to defaultDB and ensure-on-load (non-destructive)
- [x] Add server helpers (publicServer, findServer, permissions, invite codes)
- [x] Add REST endpoints: create/list/get/settings/icon/banner, channels CRUD, roles CRUD, member roles/kick/nickname, leave/delete, invites create/list/revoke, invite preview + join, member profile
- [x] Add socket events: server-send/edit/delete/typing/react (E2E ciphertext only)
- [x] Add invite-preview endpoint for link embeds
- [x] Add short `/CODE` invite redirect route

## 2. New page (servers.html)
- [x] Full server system UI: server rail, channel list, chat area, member list
- [x] Create/join server flows
- [x] Owner commands: add/delete channels, roles, badges, permissions
- [x] Server profile: icon/banner/bio editing
- [x] Member count display
- [x] Invite generation with 30min→never expiry + copy link
- [x] E2E encrypted chatroom (AES-GCM, per-server key wrapped per member)
- [x] "Back to main chat" button

## 3. Main page (index.html)
- [x] Add "Servers" nav button after Blocked (opens /servers.html)
- [x] Invite-link embeds (server name/icon/member count) in public chat, DMs, group chats, encrypted rooms

## 4. Deploy
- [x] Syntax check server.js + servers.html + index.html
- [x] Update Dockerfile to include servers.html
- [x] Local end-to-end smoke test (REST + socket)
- [x] Commit & push to GitHub master
- [x] Verify Render deploy live
- [x] Confirm no data wiped

## 5. Follow-up fixes
- [x] Fix servers page stuck on "Loading servers…" (missing socket.io client script)
- [x] Make boot() resilient + 8s safety-net timeout so page always reveals
- [x] Show create/join options on empty state (already present, now reachable)
- [x] Use main site's black favicon (/uploads/favicon.jpg) on servers page
- [x] Serve servers.html with no-cache headers (was cached 24h → stale page in browser)
- [x] Deploy + verify live (buildId 9595227c9d14)

## 6. Request C — UI polish & profile parity
- [x] Remove computer/desktop emoji icon (🖥️) under "Your Servers" heading
- [x] Make servers UI/animation flow match main chatroom/systems
- [x] Show same profile details as main chat when viewing own/others' profile
- [x] Server banner shows above the server's profile picture
- [x] Syntax check + local test
- [x] Commit & push + verify deploy (live on hellobye-chat.onrender.com)

## 7. Request D — Advanced server features
- [x] Channel privacy: owner can make channel private / private for certain roles/members
- [x] Channel chat disable: owner can disable sending (everyone / members)
- [x] User profile settings inside servers (avatar/bio/pronouns/panel theme color)
- [x] Remove right-click context menu on servers
- [x] Roles: "display roles separately" grouping in member list
- [x] Better/cartoonier "Create new server" + "Display roles separately" buttons
- [x] More advanced style/UI/animations overall
- [x] More useful Server Settings
- [x] Server banner shows under server name (where member count is) in header
- [x] Improve "My Server Profile" UI
- [x] "Back to main chat" → are-you-sure confirmation
- [x] Syntax check + local test + deploy

## 8. Request E — Professional polish & server upgrades
- [x] Remove ALL emojis from servers.html + index.html UI
- [x] Professional look (typography, spacing, borders, shadows)
- [x] My Server Profile: wider, spacious, no smushing
- [x] Server banner: longer + wider, no name overlaid on image
- [x] Replace E2E lock emoji with advanced text message
- [x] Remove member-count badge on server icon
- [x] Deleted message fully purged after 2 minutes
- [x] Edit message + Delete message confirmation UI
- [x] @everyone / @here pings with red channel notification
- [x] Syntax check + local test + deploy

## 9. Request F — UI overhaul & server upgrades
- [x] Chatroom/DMs/Groupchats: remove bubble outline, messages under usernames
- [x] Banner strip: image covers whole box; server name overlays image (not Server Settings)
- [x] Server Settings UI: wider not longer, no smushing
- [x] My Server Profile UI: wider not longer, no smushing
- [x] Discovery button under Join a server + Discoverable option shows server in discovery UI
- [x] Fade in/out animations for My Server Profile + Server Settings
- [x] Remove full right-click context menu for servers
- [x] Edit roles: add more useful Permissions
- [x] Remove SVG icon for "Leave Servers?" UI
- [x] Server icon click (non-owner): leave server + copy server id
- [x] Random 10-digit numeric SERVER id per server
- [x] Syntax check + commit/push + verify deploy + confirm no data wiped

## 10. Request G — UI fixes & bug fixes
- [x] Move time/date directly under messages (not in header, not far apart)
- [x] Hero buttons (Create/Join/Discovery): less shiny/cartoony, professional
- [x] Server banner: take over whole box under member count, image fits, remove name off banner (keep at top)
- [x] Remove emojis for Roles & Badges
- [x] Server Settings: make shiny colorful buttons professional
- [x] My Server Profile: wider, fix smushed elements, make it fit
- [x] Remove right-click "My Server Profile" for whole website
- [x] Fix channel edit button not working
- [x] Fix server ID numbers not showing up
- [x] Fix server right-click dropdown leave button + copy server id
- [x] Verification Level: remove "Highest — verified phone number", replace
- [x] Remove cartoony button from "display roles separately"
- [x] Ensure Discoverable servers show in Discovery
- [x] Syntax check + commit/push + deploy + verify live + confirm no data wiped

## 11. Request H — banner box, member menu, advanced settings, bigger chat text
- [x] Server banner: fill the whole small header box (not a spaced strip), name overlaid on banner
- [x] Non-owner right-click on server profile picture → dropdown (leave, copy server ID, etc.)
- [x] Server Settings UI: more advanced/better
- [x] My Server Profile UI: more advanced/better
- [x] My Server Profile: profile picture/banner not smushed
- [x] Server Settings: add Website Accent Colors + effects visible to everyone (server-only)
- [x] Chatroom/groupchats/DMs: messages/dates/profile pictures a bit bigger
- [x] Syntax check + commit/push + deploy + verify live + confirm no data wiped

## 12. Request I — real messages, chat-disable enforcement, unsaved warning, delete-server UI, taller banner
- [x] Server chatroom: show actual decrypted message instead of "Encrypted message"
- [x] Enforce chat-disable: disable chat input/send until owner re-enables for everyone
- [x] Unsaved-settings warning: prompt owner to save when they change an option without saving
- [x] Add a UI for the "delete server" button
- [x] Server banner: make it taller (extend downward)
- [ ] Syntax check + commit/push + deploy + verify live + confirm no data wiped
