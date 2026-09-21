# Request AP — Editable built-in roles, icon/banner scale fix, role icon outside, profile delay fix, Server Settings revamp

## Tasks
- [x] Roles & Badges: show Edit for built-in (system) roles in renderSettingsRoles(); keep Delete hidden for them
- [x] Fix Icon & Banner Scale: restore server-header-icon element + repair scaling logic
- [x] Role icon OUTSIDE the chip on the RIGHT (member-profile-role, settings-role-badge, msg-role-badge, mi-role)
- [x] Fix profile click delay: instant render from member data (no default flash)
- [x] Revamp Server Settings UI (whole UI + everything in it, no emojis)
- [x] Verify inline script syntax (node --check) on servers.html
- [x] Local smoke test (HTTP 200) + verify data/db.json preserved
- [ ] Commit + push to master
- [ ] Verify Render deploy live + markers
