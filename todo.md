# Round 17 Todo

## Sub-tasks
- [x] 1. Remove checkmark emoji/icon from Save Changes button on Profile Settings
- [x] 2. Fix XSS vulnerability in linkifyAndEmbed (escape cleanUrl in href/data-url)
- [x] 3. Fix SSRF vulnerability in /api/embed (block private/internal IPs)
- [x] 4. Fix renderEmbed single-quote escaping in url('...')
- [x] 5. Add user-ID search to /api/search-messages endpoint
- [x] 6. Redesign Search Messages UI to be very well-made + professional placeholder
- [x] 7. Refine chatroom/DM message layout (less cartoony, better UI/system)
- [x] 8. Verify/fix mobile support for all new changes
- [x] 9. Syntax-check all script blocks (index.html + server.js)
- [x] 10. Commit + push to GitHub master
- [x] 11. Verify Render auto-deploy goes live
- [x] 12. Verify site online (no data wipe) + edits grep-confirmed live

## Extra security fixes done
- [x] Path-traversal guard on /uploads static handler
- [x] Security headers: X-Content-Type-Options, Referrer-Policy, Permissions-Policy
