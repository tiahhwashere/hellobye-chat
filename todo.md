# HelloBye PC — servers window-controls overlap, Effect smush, voice wave fixes

## 1. Window controls overlap the Roles button (servers page, PC)
- [x] Reproduce: desktop mode, open server, show members -> controls overlap Roles button (top-right)
- [x] Add desktop CSS so member sidebar clears the fixed window controls (padding-top)
- [x] Verify via DOM measurement (overlap=false) + screenshot

## 2. Fix "Effect" being smushed (PC Server Settings appearance)
- [x] Root cause: `.modal.wide` (900px) overrode `.settings-modal` (1480px); `.fx-card-preview` inherited min-height:118px
- [x] Bump `.settings-modal` specificity + reset fx-card-preview min-height/height
- [x] Verify via screenshot (6-col compact grid, modal 1480px)

## 3. Voice message embed waveform (whole site / PC)
- [x] Persist duration through server cleanFiles (server-send + server-thread-send)
- [x] Make vpDecodeWave retry transient failures instead of caching a fake wave
- [ ] Verify recording -> send -> wave renders promptly (reload + test)

## 4. Remove download button in voice embed (keep beside playback speed)
- [x] Remove .vp-download button in .vp-foot from renderVoicePlayer
- [ ] Verify only .vp-dl (beside speed) remains

## 5. Deploy
- [ ] Commit + push to master (Render auto-deploy)
- [ ] Verify live site
