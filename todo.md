# Hellobye-Chat — Custom CAPTCHA (replaced Cloudflare Turnstile)

## Context
User request: "replace the Cloudflare CAPTCHA with a custom ui that alines with the site and acutally make sure it works"
Constraint: Do NOT modify `data/db.json` (md5 99761e4c34b3b0dd84d8952dfef8efd0).

## Backend (server.js) — DONE
- [x] Remove all Cloudflare Turnstile code (config, verifyTurnstileToken, /api/turnstile-sitekey)
- [x] Add custom CAPTCHA: HMAC-SHA256 signed challenges (stateless, no external deps)
- [x] Add GET /api/captcha-challenge endpoint (issues signed challenge + target position)
- [x] Add verifyCaptchaToken() with nonce replay protection + tolerance checking
- [x] Update /api/register to verify captchaToken + captchaAnswer (always required)
- [x] node -c server.js passes
- [x] Server-side unit tests: valid/replay/wrong-answer/no-token/tampered/tolerance — all pass

## Frontend (index.html) — DONE
- [x] Remove Turnstile script tag and all Turnstile JS
- [x] Remove old captcha-field CSS and HTML
- [x] Add custom CAPTCHA CSS (slider widget, dark theme, verified/error states, shake animation)
- [x] Add custom CAPTCHA HTML (slider track, handle, fill, refresh button)
- [x] Add custom CAPTCHA JS (fetch challenge, slider drag logic, verify, callbacks)
- [x] Mouse + touch + keyboard (arrow keys + Enter) support
- [x] Tab switching shows/hides captcha field + initializes widget
- [x] Update signup submit handler: requires captchaVerified, sends captchaToken + captchaAnswer
- [x] Widget resets after failed registration and network errors
- [x] Syntax-check inline JS (both blocks pass node -c)

## Deploy & Test — DONE
- [x] Verify data/db.json untouched (md5 99761e4c34b3b0dd84d8952dfef8efd0)
- [x] Commit + push to GitHub (commit 349c82e)
- [x] Render deploy live
- [x] Remove old TURNSTILE_SECRET_KEY env var on Render
- [x] API tests live:
  - [x] /api/captcha-challenge returns signed challenge + target
  - [x] Register WITHOUT captcha → 403 (rejected)
  - [x] Register WITH valid captcha → 200 (account created)
  - [x] Register WITH wrong answer → 403 (rejected)
- [x] Browser visual tests:
  - [x] Custom slider renders in dark theme matching site design
  - [x] Slider drag to correct position → "Verified" (green checkmark)
  - [x] Slider drag to wrong position → error shake + auto-reset
  - [x] Refresh button fetches new challenge
  - [x] Full signup with CAPTCHA → account created, welcome modal shown
  - [x] Full signup after refresh → account created successfully

## Notes
- CAPTCHA is always required (no graceful degradation — every signup must pass)
- HMAC-SHA256 signed challenges are stateless (no session storage needed)
- Nonce replay protection prevents token reuse
- 5-minute challenge expiry
- ±5% tolerance on slider position for human imprecision
- data/db.json md5 confirmed unchanged: 99761e4c34b3b0dd84d8952dfef8efd0
