# Round 21 — Chat UX, Profile Banner Unsaved-Guard, Admin Real-Time, UI Polish

## Tasks

### A. Chatroom / DMs — Edit & Delete keyboard shortcuts (Enter)
- [x] 1. startEditMessage: Enter key on edit input saves
- [x] 2. startEditDM: Enter key on edit input saves
- [x] 3. Delete modal: Enter = confirm delete, Esc = cancel

### B. Chatroom / DMs — Image click zoom (lightbox) instead of link
- [x] 4. createFileElement image onclick → in-app lightbox (not window.open)
- [x] 5. Add lightbox HTML + CSS + close handlers (backdrop, Esc, X)

### C. Profile Settings — Banner removal unsaved-changes guard
- [x] 6. banner-remove-btn: local-only preview (no immediate remove-image), markProfileDirty
- [x] 7. saveProfileNow: commit pending banner removal on Save
- [x] 8. Verify Discard restores banner to saved snapshot

### D. Admin — Account Credentials & Sessions real-time (signup / delete account)
- [x] 9. server.js: emit 'admin-data-changed' on register + delete-account
- [x] 10. index.html: listen 'admin-data-changed' → loadAdminData() if panel open

### E. Broadcast System Alert UI — basic/professional/modern
- [x] 11. Redesign .system-alert CSS

### F. Quick Presets UI — better/professional
- [x] 12. Redesign .bg-preset-chip + label + container CSS

### G. 2-Step Verification UI — remove shield icon
- [x] 13. Remove shield from .twosv-icon (login overlay)

### H. Verify & Sign In button — remove black checkmark
- [x] 14. Remove .twosv-btn::before checkmark

### I. Profile Settings — @ handle + ID: text → white
- [x] 15. .profile-username-handle → white
- [x] 16. .profile-userid → white (fixed .profile-v2-idblock override too)

### J. Adjust Banner modal — upgraded layout/UI
- [x] 17. Polish .image-scale-modal CSS

### K. Messages / DMs layout UI upgrade
- [x] 18. Polish message-bubble / actions / meta / edit-input CSS

### L. Deploy
- [x] 19. Syntax-check index.html + server.js
- [ ] 20. Commit + push (Render autoDeploy)
- [ ] 21. Verify live + no data wipe
