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

## Deploy & Test
- [x] Syntax-check inline JS after edits (both blocks pass node -c)
- [x] Verify data/db.json untouched (md5 99761e4c34b3b0dd84d8952dfef8efd0)
- [ ] Commit + push to GitHub (git push origin master)
- [ ] Wait for Render auto-deploy
- [ ] Test CAPTCHA flow live

## Notes
- Test sitekey 1x00000000000000000000AA always passes (visible widget)
- Test secret 1x0000000000000000000000000000000AA always passes validation
- Without TURNSTILE_SECRET_KEY set on Render, server skips verification (app works)
- User can create real widget at Cloudflare dashboard for production keys
