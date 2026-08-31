# Hellobye-Chat — Replace Cloudflare Turnstile with Custom CAPTCHA

## Context
User request: "replace the Cloudflare CAPTCHA with a custom ui that alines with the site and acutally make sure it works"
Constraint: Do NOT modify `data/db.json` (md5 99761e4c34b3b0dd84d8952dfef8efd0).

## Plan
Custom CAPTCHA = server-issued signed challenge + dark-themed slider puzzle widget.
- Server: HMAC-SHA256 signed challenge (nonce + target position). Stateless, no session storage.
- Frontend: Custom slider "drag to verify" widget matching hellobye dark theme.
- No external dependencies (no Cloudflare script).

## Backend (server.js)
- [ ] Remove all Turnstile code (config block, verifyTurnstileToken, /api/turnstile-sitekey)
- [ ] Add custom CAPTCHA: HMAC secret, /api/captcha-challenge (issue signed challenge), verifyCaptchaToken()
- [ ] Update /api/register to use new captchaToken (signed challenge + answer)
- [ ] node -c server.js passes

## Frontend (index.html)
- [ ] Remove Turnstile script tag
- [ ] Remove Turnstile state vars and JS functions (onTurnstileLoad, renderSignupCaptcha, etc.)
- [ ] Remove old captcha-field CSS and HTML
- [ ] Add custom CAPTCHA CSS (slider widget, dark theme)
- [ ] Add custom CAPTCHA HTML (slider track, handle, status)
- [ ] Add custom CAPTCHA JS (fetch challenge, slider drag logic, verify, callbacks)
- [ ] Update tab-switching logic for new captcha
- [ ] Update signup submit handler to use new captchaToken
- [ ] Syntax-check inline JS (node -c)

## Deploy & Test
- [ ] Verify data/db.json untouched
- [ ] Commit + push to GitHub
- [ ] Wait for Render deploy
- [ ] Remove TURNSTILE_SECRET_KEY env var on Render
- [ ] Test CAPTCHA flow live (challenge endpoint, slider, register with/without token)
- [ ] Visual verification via browser
