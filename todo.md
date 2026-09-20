# Request AA — Remove the server icon next to the server name (keep the rail one)

## 1. Remove header icon
- [x] Remove `<div class="server-header-icon" id="server-header-icon">` from the channel-sidebar header
- [x] Confirm JS guards (`if (iconEl)` / `if (headerIconEl)`) make removal safe
- [x] Keep the server rail icon (`#rail-servers`) intact

## 2. Verify & Deploy
- [x] node --check on extracted servers.html script
- [x] Smoke test locally (servers.html 200, header icon gone, rail present)
- [ ] Commit + push to GitHub master
- [ ] Trigger/verify Render deploy (no data wiped)
