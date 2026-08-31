# Hellobye-Chat — CAPTCHA (Cloudflare Turnstile) Implementation

## Context
User request: "when the user clicks create account add an captcha verify type system."
Constraint: Do NOT modify `data/db.json` (md5 99761e4c34b3b0dd84d8952dfef8efd0).

## Backend (server.js) — DONE
- [x] Add Turnstile config block (sitekey, secret, isTurnstileEnabled, verifyTurnstileToken)
- [x] Add GET /api/turnstile-sitekey endpoint
- [x] Add CAPTCHA verification at start of /api/register (returns 403 if invalid)
- [x] node -c server.js passes
- [x] Graceful degradation: if TURNSTILE_SECRET_KEY unset, verification skipped

## Frontend (index.html) — DONE
- [x] Add Turnstile script tag (render=explicit, onload=onTurnstileLoad)
- [x] Add CAPTCHA widget container HTML (#signup-captcha-field, #signup-captcha-widget)
- [x] Add CSS for .captcha-field
- [x] Submit button disabled by default
- [x] Add global Turnstile state variables (turnstileWidgetId, token, sitekey, ready)
- [x] Define window.onTurnstileLoad function (fetch sitekey, render widget)
- [x] Add renderSignupCaptcha() function (dark theme, callbacks)
- [x] Hook tab-switching to show/hide captcha field + render widget
- [x] Update signup submit handler: require token, send captchaToken, reset on failure

## Deploy & Test — DONE
- [x] Syntax-check inline JS after edits (both blocks pass node -c)
- [x] Verify data/db.json untouched (md5 99761e4c34b3b0dd84d8952dfef8efd0)
- [x] Commit + push to GitHub (git push origin master, commit bb8a62d)
- [x] Wait for Render auto-deploy (deploy live)
- [x] Test CAPTCHA flow live:
  - [x] /api/turnstile-sitekey returns sitekey + enabled flag
  - [x] Turnstile widget renders in dark theme on signup tab (shows "Success!")
  - [x] Submit button disabled until CAPTCHA verified
  - [x] Full signup with CAPTCHA creates account successfully
  - [x] Register WITHOUT captchaToken → 403 (rejected when CAPTCHA enabled)
  - [x] Register WITH captchaToken → 200 (accepted)
- [x] Set TURNSTILE_SECRET_KEY env var on Render (test secret: 1x0000000000000000000000000000000AA)

## Notes
- Test sitekey 1x00000000000000000000AA always passes (visible widget)
- Test secret 1x0000000000000000000000000000000AA always passes validation
- Currently using test keys on Render — CAPTCHA widget is visible and functional
- For production: user creates real widget at https://dash.cloudflare.com/?to=/:/turnstile
  and sets real TURNSTILE_SITEKEY + TURNSTILE_SECRET_KEY env vars on Render
- data/db.json md5 confirmed unchanged: 99761e4c34b3b0dd84d8952dfef8efd0
