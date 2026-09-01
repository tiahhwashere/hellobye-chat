# Hellobye-Chat — Remove fine print + Fix Unknown device labels

## Context
User request: "remove the 'Protected sessions · Encrypted credentials · v2.0' fine print and fix the Active Unknown and the Unknown show the actual device and actual other useful info"

## Changes Needed
- [x] index.html: Remove the "Protected sessions · Encrypted credentials · v2.0" auth footer
- [x] server.js: Enrich legacy sessions with metadata (browser/os/ip/deviceType) when accessed via getSession() — so old sessions show real device info instead of "Unknown"
- [x] index.html: Fix deviceCardHTML to show useful info instead of "Unknown browser · Unknown" and "Active Unknown" — use fallback labels that are still informative
- [x] Syntax check both files
- [x] Test locally
- [ ] Restore db.json, commit, push, deploy, verify live
