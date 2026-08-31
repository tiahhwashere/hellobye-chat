# Round 9 — Email Verification on Signup

## Investigation
- [x] Find signup/create-account UI in index.html (username, password fields)
- [x] Find signup backend handler in server.js
- [x] Check if nodemailer / googleapis already installed (installed both)
- [x] Find existing toast/validation patterns for signup
- [x] Check Render env vars / package.json

## Backend (Resend API — replaced Gmail OAuth)
- [x] Add Resend email sender (built-in https module, no nodemailer needed)
- [x] Add /api/send-verify-code endpoint (kept for reference, now unused)
- [x] Add /api/verify-code endpoint (kept for reference, now unused)
- [x] Rewrite /api/register as async two-phase flow:
  - Phase 1 (no code): validate input, generate 5-digit code, email it, return {needsVerification:true}
  - Phase 2 (with code): validate code, create account, return session
- [x] Duplicate-email check + rate limiting + expiry + attempt limits

## Frontend (Two-phase flow — no Send Code button)
- [x] Remove "Send Code" button from email field in HTML
- [x] Hide the 5-digit code input row until server confirms code was sent
- [x] Replace old JS handlers (send-verify-btn click, auto-verify, verifyToken submit)
- [x] New single submit handler: Phase 1 sends {username,password,email}, Phase 2 adds code
- [x] Handle needsVerification response: reveal code input, focus it, show status message
- [x] Reset verification state when email changes or send fails

## Deploy (flow redesign)
- [x] Syntax check server.js (node -c) — pass
- [x] Syntax check inline JS in index.html (extract + node -c) — pass
- [x] db.json untouched (md5 99761e4c34b3b0dd84d8952dfef8efd0 verified)
- [x] Commit + push to GitHub (83660d0)
- [x] Render auto-deploy triggered and went live
- [x] Test Phase 1 live: POST /api/register (no code) -> {needsVerification:true, message sent}
- [x] Test Phase 2 live: POST /api/register (wrong code) -> {error: "Incorrect verification code"}
