# Round 3 — Adjust Profile Picture UI Sizing + Loading Fix

## Tasks
- [x] 1. Make Adjust Profile Picture UI smaller/wider (avatar frame capped to 264px square, centered in fixed 300px stage; modal 620px -> 560px)
- [x] 2. Make Adjust Profile Picture & Adjust Banner the same UI size (both share a fixed 300px-height preview stage)
- [x] 3. Fix "slowly loading all the way down delay" (image stays opacity:0 via .loading class until img.onload fires, then fades in — no reflow/crawl)
- [x] 4. Commit, push, deploy, verify (commit 2bcd167, live on render, no data wiped)
