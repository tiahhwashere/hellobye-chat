# Round 9 — Email Verification on Signup (Gmail OAuth)

## Investigation
- [x] Find signup/create-account UI in index.html (username, password fields)
- [x] Find signup backend handler in server.js
- [x] Check if nodemailer / googleapis already installed (installed both)
- [x] Find existing toast/validation patterns for signup
- [x] Check Render env vars / package.json

## Backend
- [x] Install nodemailer + googleapis
- [x] Add Gmail OAuth transporter (client id + secret + refresh token from env)
- [x] Add /api/send-verify-code endpoint (email -> 5-digit code, stores, sends email)
- [x] Add /api/verify-code endpoint (email + code -> validates, returns verifyToken)
- [x] Modify signup to require verified email + verifyToken, stores email on user
- [x] Duplicate-email check + rate limiting + expiry + attempt limits

## Frontend
- [x] Add email input field under "Choose a Username"
- [x] Add verification code input + "Send Code" button
- [x] Add verification flow UI (send -> enter code -> auto-verify -> enable signup)
- [x] Wire up fetch calls to backend endpoints
- [x] Toast/status feedback for send/verify/success/error
- [x] 60s resend cooldown with countdown, reset on email change

## Deploy
- [x] Syntax check (server.js + inline JS)
- [x] Local boot test
- [x] db.json untouched
- [x] Commit + push to GitHub (d53d257)
- [x] Switched from Gmail OAuth to Resend API (no OAuth needed)
- [x] Test send-verify-code locally (real email sent successfully)
- [x] Test verify-code + register rejection locally
- [x] Commit + push Resend changes to GitHub (c8baeb0)
- [x] Add RESEND_API_KEY env var on Render
- [x] Verify Render deploy live (dep-daasm7p42hec)
- [x] Confirm features on live site (email sent + rate limit + UI all working)
