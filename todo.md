# Request BI — webhook delete UI, short invite links, embed icons, role UI, audit logs, private server, profile roles, private profile UI, leave server UI

## 1. Custom "Delete webhook" confirmation UI (replace browser confirm)
- [x] Build custom confirm modal
- [x] Wire into webhook delete

## 2. Short invite links display (./code) when custom link used
- [x] Detect custom short links vs long servers.html?invite=
- [x] Render as ./code

## 3. Remove icon/SVG on video/audio/gif/image embeds
- [x] Remove mfc-ic icon from media download bar

## 4. "Create Role" UI — General Server options well made, no emojis/cartoony
- [x] Review role editor General tab
- [x] Redesign options

## 5. Server Settings — Audit Logs (owner/admins only)
- [x] Backend audit log storage + endpoints
- [x] Frontend audit log UI
- [x] Log messages/media/kick/ban

## 6. Better Accent color / custom UI (no emojis/cartoony)
- [x] Review accent color UI
- [x] Improve

## 7. Server Settings — private server + request-to-join (accept/decline)
- [x] Backend private flag + join requests
- [x] Frontend request management UI

## 8. Profile roles bigger
- [x] Increase role chip size

## 9. Main chat "This Profile is Private" UI — better/advanced, no icons/SVG
- [x] Redesign private profile UI

## 10. "Leave Server" UI
- [x] Build leave server UI

## 11. Verify + deploy
- [ ] Syntax checks
- [ ] Commit + push + Render deploy + verify
