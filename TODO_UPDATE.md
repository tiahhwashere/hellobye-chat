# HelloBye Update 3 — Todo

## 1. Advanced "Welcome back" / "Log back in with last account" UI
- [x] Redesign hbRenderWelcomeBack: eyebrow "Session detected", avatar initials, handle, verified/sign-in-required badge
- [x] Session facts (account, last active relative+absolute, device, session key) + "Will be restored (N/4)" checklist
- [x] Footer note + "Use a different account" / "Resume session" actions; no emojis, non-cartoonish

## 2. Fix Members List Background that reverted
- [x] saveMembersBgState: quota retry + canvas re-encode fallback + hbPersistCarryover hook

## 3. Fix Chat Background that reverted
- [x] saveBgSettings: carryover hardening (dedupe + forced persistence on pagehide/beforeunload/visibilitychange/interval)

## 4. Fix Profile Panel colour (PC/desktop) that reverted
- [x] saveProfileColor/saveColorSettings: hbPersistCarryover hook
- [x] hbSeedPanelColorFromServer: server-side panelColor fallback on init
- [x] Flush carryover before self-update (preload event + main.js executeJavaScript)

## 5. Revamp "create a server" SVG icon
- [x] Replace rail + hero create-server SVG with a server + add-badge glyph (matches site style)

## Ship
- [x] Bump desktop version (1.6.2 -> 1.6.3)
- [x] Build + publish desktop release (desktop-v1.6.3) with HelloBye-Setup.exe / HelloBye-Portable.exe
- [x] Update server.js DESKTOP_FALLBACK + download.html to v1.6.3
- [x] Commit + push to GitHub
- [x] Verify Render deploy live (dep-daqpsgbbc2fs739l8uu0) + live endpoints 200
