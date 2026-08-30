# Round 5c — Whitelisted admins bypass the code gate; rename "Admin Code Required"

## Tasks
- [ ] 1. server.js: extend isAdmin() so users on the admin whitelist (and admin-role users) are admin WITHOUT needing the code — fixes /api/admin/check to return isAdmin:true for them
- [ ] 2. index.html: rename "Admin Code Required" heading (and the lock-screen copy) to something slightly more professional
- [ ] 3. Update the server.js comment block describing admin access rules
- [ ] 4. Syntax check, commit, push, deploy, verify on Render (no data wiped)
