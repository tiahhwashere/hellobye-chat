# Request AJ — Server chats must NEVER be encrypted (no "Encrypted message")

## Tasks
- [x] server.js: `server-send` — always store plaintext, ignore e2e envelope
- [x] server.js: `server-edit` — always store plaintext, ignore e2e envelope
- [x] server.js: search endpoint — drop e2e candidate logic (plaintext now)
- [x] servers.html: `sendMessage` — stop encrypting, send plaintext
- [x] servers.html: `editMessage` — stop encrypting, send plaintext
- [x] servers.html: `server-message` socket handler — render plaintext directly
- [x] servers.html: `server-edited` socket handler — render plaintext directly
- [x] servers.html: `appendMessage` — remove "Encrypted message" fallback
- [x] servers.html: reply quote + search — remove "Encrypted message" fallback
- [x] servers.html: remove "Encrypted" badge on messages
- [x] Verify inline script syntax (node --check) on both files
- [x] Local smoke test (HTTP 200)
- [x] Verify data/db.json preserved
- [x] Commit + push to master
- [x] Verify Render deploy live + markers
- [x] Update todo.md and commit
